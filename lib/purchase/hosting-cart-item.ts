/**
 * The cart items a hosting purchase produces.
 *
 * Lifted from `app/hosting/HostingPageClient.tsx` when that page was removed
 * (owner decision, 24 Sep 2026), then re-priced the same day: the owner ruled
 * that ResellerOS's price is the correct one, which means ResellerOS's
 * ex-GST rate PLUS 18% GST. DMS's cart totals a line as `price × months` and
 * treats the result as GST-inclusive, so each line now carries
 * `hostingCharge(...).inclGst / months` — see lib/pricing/hosting-price.ts.
 *
 * Nothing trusts this client-side figure for the charge: create-order
 * re-prices every hosting line on the server from the same function.
 */
import type { CartItem } from "@/lib/types";
import type { HostingPlanConfig } from "@/config/hosting-plans";
import { cartLinePrice, hostingCharge, type HostingCharge } from "@/lib/pricing/hosting-price";

export type BillingCycle = "monthly" | "yearly";

/**
 * The ResellerOS charge for a plan and cycle. Throws for a plan ResellerOS
 * does not sell: the dialog only offers the three that it does, so reaching
 * this with anything else is a bug to surface, not a price to guess.
 */
export function chargeFor(plan: Pick<HostingPlanConfig, "id">, cycle: BillingCycle): HostingCharge {
  const charge = hostingCharge(plan.id, cycle);
  if (!charge) throw new Error(`No ResellerOS price for hosting plan "${plan.id}"`);
  return charge;
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
  const charge = chargeFor(plan, cycle);
  const period = charge.months;

  const item: CartItem & { linkedDomain?: string } = {
    domainName: `hosting-${plan.id}-${now}`,
    price: cartLinePrice(charge),
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
 * A free-trial line: ₹0 today, then the plan's ResellerOS yearly price.
 *
 * `price` is the today-charge and stays 0; `hostingPlan.price` carries the
 * post-trial per-month figure (GST-inclusive, so checkout's "× 12" shows the
 * real yearly charge). Eligibility is checked by the caller AND again by
 * create-order — this only builds the line.
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
      price: cartLinePrice(chargeFor(plan, "yearly")),
    },
  };
}
