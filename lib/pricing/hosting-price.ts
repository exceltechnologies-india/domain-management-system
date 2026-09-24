/**
 * What DMS charges for hosting — ResellerOS's price, plus 18% GST.
 *
 * Owner decisions, 24 Sep 2026: "Use the prices of hosting set in ResellerOS
 * completely", and, asked whether a hosting figure includes GST or not,
 * "ResellerOS is correct price one. Use that."
 *
 * ResellerOS (`api/public/checkout/cart`) prices a hosting line as
 *
 *     rate   = Math.round(yearly ? price × 12 : price × 2)   // ex-GST, whole ₹
 *     amount = Math.round(rate × 1.18)                        // what is paid
 *
 * where `price` is its LANDING_PLANS per-month rate on yearly billing. DMS used
 * to treat that same per-month figure as GST-INCLUSIVE and back the tax out of
 * it — so a Starter year cost ₹599.88 here and ₹708 there. This module is the
 * ResellerOS formula, and every place DMS charges for hosting reads it:
 * the panel dialog, create-order (member and guest), the manual renewal,
 * the upgrade proration and the expiry worker's pending renewal.
 *
 * Downstream DMS still treats an order's `amount` as GST-inclusive (the cart
 * summary, checkout, the invoice engine in lib/billing/gst.ts all compute
 * taxable = amount × 100/118). So charging `inclGst` here makes all of those
 * show ₹600 taxable + ₹108 GST for a Starter year, with no change to them.
 *
 * `config/hosting-plans.ts` is the input: its three per-month figures equal
 * ResellerOS's LANDING_PLANS, pinned by tests/unit/lib/purchase/purchase.test.ts.
 * Mongo `hostingplans.price` is NOT an input — decision 7 disregards DMS's own
 * prices — which is why a plan that exists only in Mongo returns null here.
 */
import { HOSTING_PLANS } from "@/config/hosting-plans";

export type HostingCycle = "monthly" | "yearly";

/** GST on hosting (SAC 998315), as ResellerOS applies it. */
export const HOSTING_GST_RATE = 0.18;

export interface HostingCharge {
  planId: string;
  /** Display name, e.g. "Starter". */
  planName: string;
  cycle: HostingCycle;
  /** Months the charge covers: 12 or 1. */
  months: number;
  /** Taxable value, whole rupees — ResellerOS's `rate`. */
  exGst: number;
  /** What the customer pays, whole rupees — ResellerOS's `amount`. */
  inclGst: number;
  /** inclGst − exGst. */
  gst: number;
}

/**
 * The charge for a plan and cycle, or `null` when the plan is not one
 * ResellerOS sells (e.g. a DirectAdmin-internal package like "25GB-wp").
 *
 * `null` is deliberate: the caller must refuse, not substitute a figure
 * (AGENTS.md §2 — a failure converted into a plausible value is worse).
 * Plan ids match case-insensitively because Mongo stores "Starter" and the
 * cart sends "starter".
 */
export function hostingCharge(planId: string | null | undefined, cycle: HostingCycle): HostingCharge | null {
  const key = (planId ?? "").trim().toLowerCase();
  const plan = Object.prototype.hasOwnProperty.call(HOSTING_PLANS, key) ? HOSTING_PLANS[key] : undefined;
  if (!plan) return null;
  const yearly = cycle === "yearly";
  const exGst = Math.round(yearly ? plan.price * 12 : plan.price * 2);
  const inclGst = Math.round(exGst * (1 + HOSTING_GST_RATE));
  return { planId: plan.id, planName: plan.name, cycle, months: yearly ? 12 : 1, exGst, inclGst, gst: inclGst - exGst };
}

/**
 * The cycle a cart or order line bought, from its period. DMS stores a
 * hosting line as N months; 12 is yearly, anything else is monthly — the same
 * reading create-order has always used (`registrationPeriod === 12`).
 */
export function cycleFromMonths(months: number | null | undefined): HostingCycle {
  return months === 12 ? "yearly" : "monthly";
}

/**
 * The per-month figure to put on a cart line so that `price × months` — how
 * the cart, checkout and create-order all total a line — equals `inclGst`.
 *
 * Not always a round number (₹2,650 ÷ 12), so anything that SUMS lines must
 * round the total to paise; `lineTotal` does that for one line.
 */
export function cartLinePrice(charge: HostingCharge): number {
  return charge.inclGst / charge.months;
}

/** A hosting line's total in rupees, rounded to paise. */
export function lineTotal(price: number, months: number): number {
  return Math.round(price * months * 100) / 100;
}

/**
 * A plan's per-month rate for proration: its ResellerOS yearly price incl.
 * GST, spread over 12 months. `null` for a plan ResellerOS does not price.
 */
export function perMonthRate(planId: string | null | undefined): number | null {
  const yearly = hostingCharge(planId, "yearly");
  return yearly ? yearly.inclGst / 12 : null;
}

export type UpgradeCharge =
  | { ok: true; amount: number }
  | { ok: false; reason: "unpriced" | "not-higher" };

/**
 * The prorated charge to move from one plan to a dearer one for the days left.
 *
 * Same formula `api/user/hosting/upgrade` always used — difference in monthly
 * rate × remaining days / 30, rounded, never below ₹100 — with the monthly
 * rates now ResellerOS's (perMonthRate) instead of Mongo `hostingplans.price`.
 * upgrade-info and upgrade both call this, so the quote and the charge match.
 */
export function upgradeCharge(
  currentPlanId: string | null | undefined,
  targetPlanId: string | null | undefined,
  remainingDays: number
): UpgradeCharge {
  const current = perMonthRate(currentPlanId);
  const target = perMonthRate(targetPlanId);
  if (current === null || target === null) return { ok: false, reason: "unpriced" };
  if (target <= current) return { ok: false, reason: "not-higher" };
  return { ok: true, amount: Math.max(100, Math.round(((target - current) * remainingDays) / 30)) };
}
