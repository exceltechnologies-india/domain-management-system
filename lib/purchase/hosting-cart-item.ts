/**
 * The cart item a hosting TRIAL produces, and the ResellerOS charge per plan.
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

// A PAID hosting line used to be built here too (buildHostingCartItem). It was
// deleted on 25 Sep 2026 with its last caller: owner decision 30 moved paid
// in-panel purchases off DMS's cart to ResellerOS (components/purchase/
// PanelCheckout.tsx). Only the ₹0 trial line still goes into DMS's cart.

/**
 * A free-trial line: ₹0 today, then the plan's ResellerOS price for the chosen
 * cycle — yearly, or monthly since 24 Sep 2026 (Starter only, both cycles).
 *
 * `price` is the today-charge and stays 0; `hostingPlan.price` carries the
 * post-trial per-month figure (GST-inclusive). `billingCycle` is what the trial
 * converts to, and create-order stores it on the hosting so the renewal charges
 * the same cycle. Eligibility is checked by the caller AND again by
 * create-order — this only builds the line.
 */
export function buildTrialCartItem(
  plan: HostingPlanConfig,
  cycle: "monthly" | "yearly" = "yearly",
  now: number = Date.now(),
): CartItem {
  return {
    domainName: `hosting-trial-${plan.id}-${now}`,
    price: 0,
    currency: plan.currency,
    registrationPeriod: 15,
    periodUnit: "days",
    itemType: "hosting",
    billingCycle: cycle,
    isTrial: true,
    hostingPlan: {
      id: plan.id,
      name: `${plan.name} Hosting`,
      period: 15,
      features: [...plan.features, "15-Day Free Trial", ...(cycle === "yearly" ? ["30-Day Money-Back Guarantee"] : [])],
      serverPackage: plan.serverPackage,
      price: cartLinePrice(chargeFor(plan, cycle)),
    },
  };
}
