/**
 * What hosting costs — ResellerOS's price, read LIVE from ResellerOS.
 *
 * Owner decisions: 24 Sep 2026, "Use the prices of hosting set in ResellerOS
 * completely" and "ResellerOS is correct price one"; 28 Sep 2026, "Read prices
 * live from ResellerOS". Until that date DMS kept a copy of the three per-month
 * figures in `config/hosting-plans.ts`, pinned by a test to numbers copied on
 * 24 Sep — so a price change in ResellerOS would have left this panel showing
 * one figure while ResellerOS charged another, with nothing failing.
 *
 * Now every figure here comes from a `HostingPriceTable`: ResellerOS's
 * `GET /api/public/hosting-prices`, computed there by the same function its
 * checkout charges with. Servers read it with `lib/reselleros/hosting-prices.ts`;
 * the browser with `hooks/useHostingPrices.ts`. There is no built-in fallback:
 * without a table there is no price, and the caller says so (AGENTS.md §2).
 *
 * Downstream DMS still treats an order's `amount` as GST-inclusive (the cart
 * summary, checkout, lib/billing/gst.ts compute taxable = amount × 100/118), so
 * charging `inclGst` makes all of those show ₹600 taxable + ₹108 GST for a
 * Starter year, with no change to them. Mongo `hostingplans.price` is NOT an
 * input — decision 7 disregards DMS's own prices.
 */

export type HostingCycle = "monthly" | "yearly";

/** GST on hosting (SAC 998315), as ResellerOS applies it. */
export const HOSTING_GST_RATE = 0.18;

/** One cycle's price, as ResellerOS publishes it. Whole rupees. */
export interface HostingCyclePrice {
  months: number;
  exGst: number;
  inclGst: number;
}

/** One plan, as ResellerOS publishes it. */
export interface HostingPlanPrice {
  id: string;
  name: string;
  /** ₹/month when billed yearly (ex-GST) — the headline on the plan cards. */
  perMonthYearly: number;
  yearly: HostingCyclePrice;
  monthly: HostingCyclePrice;
}

/** ResellerOS's `GET /api/public/hosting-prices` body. */
export interface HostingPriceTable {
  gstRate: number;
  plans: HostingPlanPrice[];
}

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

/** The plan in the table, matched case-insensitively (Mongo stores "Starter", the cart "starter"). */
export function planPrice(table: HostingPriceTable, planId: string | null | undefined): HostingPlanPrice | null {
  const key = (planId ?? "").trim().toLowerCase();
  return table.plans.find((p) => p.id.toLowerCase() === key) ?? null;
}

/**
 * The charge for a plan and cycle, or `null` when ResellerOS does not price
 * that plan (e.g. a DirectAdmin-internal package like "25GB-wp").
 *
 * `null` is deliberate: the caller must refuse, not substitute a figure
 * (AGENTS.md §2 — a failure converted into a plausible value is worse).
 */
export function hostingCharge(
  table: HostingPriceTable,
  planId: string | null | undefined,
  cycle: HostingCycle
): HostingCharge | null {
  const plan = planPrice(table, planId);
  if (!plan) return null;
  const c = cycle === "yearly" ? plan.yearly : plan.monthly;
  return { planId: plan.id, planName: plan.name, cycle, months: c.months, exGst: c.exGst, inclGst: c.inclGst, gst: c.inclGst - c.exGst };
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
export function perMonthRate(table: HostingPriceTable, planId: string | null | undefined): number | null {
  const yearly = hostingCharge(table, planId, "yearly");
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
 * rates ResellerOS's (perMonthRate) instead of Mongo `hostingplans.price`.
 * upgrade-info and upgrade both call this, so the estimate and the request match.
 */
export function upgradeCharge(
  table: HostingPriceTable,
  currentPlanId: string | null | undefined,
  targetPlanId: string | null | undefined,
  remainingDays: number
): UpgradeCharge {
  const current = perMonthRate(table, currentPlanId);
  const target = perMonthRate(table, targetPlanId);
  if (current === null || target === null) return { ok: false, reason: "unpriced" };
  if (target <= current) return { ok: false, reason: "not-higher" };
  return { ok: true, amount: Math.max(100, Math.round(((target - current) * remainingDays) / 30)) };
}

/**
 * Read a ResellerOS price table from an unknown JSON body, or null when any
 * figure is missing or not a positive number — a half-read table is not a price.
 */
export function parseHostingPriceTable(body: unknown): HostingPriceTable | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const cyc = (v: unknown): HostingCyclePrice | null => {
    const c = (v ?? {}) as Record<string, unknown>;
    const months = num(c.months), exGst = num(c.exGst), inclGst = num(c.inclGst);
    return months && exGst && inclGst ? { months, exGst, inclGst } : null;
  };
  const gstRate = num(b.gstRate);
  if (!gstRate || !Array.isArray(b.plans) || b.plans.length === 0) return null;
  const plans: HostingPlanPrice[] = [];
  for (const raw of b.plans) {
    const p = (raw ?? {}) as Record<string, unknown>;
    const perMonthYearly = num(p.perMonthYearly);
    const yearly = cyc(p.yearly), monthly = cyc(p.monthly);
    if (typeof p.id !== "string" || !p.id || typeof p.name !== "string" || !perMonthYearly || !yearly || !monthly) return null;
    plans.push({ id: p.id, name: p.name, perMonthYearly, yearly, monthly });
  }
  return { gstRate, plans };
}
