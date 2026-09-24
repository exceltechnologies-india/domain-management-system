/**
 * The cart items a hosting purchase produces.
 *
 * Lifted UNCHANGED from `app/hosting/HostingPageClient.tsx` when that page was
 * removed (owner decision, 24 Sep 2026 — DMS's public pages give way to
 * ResellerOS's). The in-panel purchase dialog builds its items here, so the
 * cart, `/api/payments/create-order` and the trial checks receive exactly the
 * shape they always have. Nothing about pricing changed in the move.
 *
 * PRICES. The owner decided ResellerOS's hosting prices are the only ones
 * (`LANDING_PLANS` in ResellerOS). `config/hosting-plans.ts` carries the same
 * three figures today — Starter 49.99, Standard 125, Plus 187.20 per month on
 * yearly billing, monthly billing at 2×, a year at 12× — so the dialog shows
 * and charges the ResellerOS price. It is still a second copy of those
 * numbers, and reading them from ResellerOS instead is an open item in
 * ResellerOS's Todos.md §0A. Until then, a change to a ResellerOS price has
 * to be made here too.
 */
import type { CartItem } from "@/lib/types";
import type { HostingPlanConfig } from "@/config/hosting-plans";

export type BillingCycle = "monthly" | "yearly";

/** Monthly billing costs twice the per-month rate of a yearly plan. */
export function monthlyRate(plan: Pick<HostingPlanConfig, "price">): number {
  return plan.price * 2;
}

/** ₹/month as displayed for a billing cycle. */
export function displayRate(plan: Pick<HostingPlanConfig, "price">, cycle: BillingCycle): number {
  return cycle === "monthly" ? monthlyRate(plan) : plan.price;
}

/**
 * A paid hosting line.
 *
 * If the cart already holds a domain that no hosting line is linked to, the
 * new line is linked to it — create-order refuses a hosting line with no
 * provisionable domain, so an unlinked line would only fail later.
 */
export function buildHostingCartItem(
  plan: HostingPlanConfig,
  cycle: BillingCycle,
  cartItems: readonly CartItem[],
  now: number = Date.now()
): CartItem & { linkedDomain?: string } {
  const existingDomain = cartItems.find((item) => !item.itemType || item.itemType === "domain");
  const isDomainAlreadyLinked =
    !!existingDomain &&
    cartItems.some(
      (item) => item.itemType === "hosting" && item.linkedDomain === existingDomain.domainName
    );

  const isMonthly = cycle === "monthly";
  const period = isMonthly ? 1 : 12;

  const item: CartItem & { linkedDomain?: string } = {
    domainName: `hosting-${plan.id}-${now}`,
    price: displayRate(plan, cycle),
    currency: plan.currency,
    registrationPeriod: period,
    periodUnit: "months",
    itemType: "hosting",
    billingCycle: cycle,
    hostingPlan: {
      id: plan.id,
      name: `${plan.name} Hosting`,
      period,
      features: [...plan.features, ...(isMonthly ? [] : ["30-Day Money-Back Guarantee"])],
      serverPackage: plan.serverPackage,
    },
  };

  if (existingDomain && !isDomainAlreadyLinked) {
    item.linkedDomain = existingDomain.domainName;
  }
  return item;
}

/**
 * A free-trial line: ₹0 today, then the plan's yearly rate.
 *
 * `price` is the today-charge and stays 0; `hostingPlan.price` carries the
 * post-trial rate so checkout can say "then ₹X". Eligibility is checked by
 * the caller AND again by create-order — this only builds the line.
 */
export function buildTrialCartItem(plan: HostingPlanConfig, now: number = Date.now()): CartItem {
  return {
    domainName: `hosting-trial-${plan.id}-${now}`,
    price: 0,
    currency: plan.currency,
    registrationPeriod: 15,
    periodUnit: "days",
    itemType: "hosting",
    billingCycle: "yearly",
    isTrial: true,
    hostingPlan: {
      id: plan.id,
      name: `${plan.name} Hosting`,
      period: 15,
      features: [...plan.features, "15-Day Free Trial", "30-Day Money-Back Guarantee"],
      serverPackage: plan.serverPackage,
      price: plan.price,
    },
  };
}
