/**
 * Server-side re-pricing of hosting cart lines, before anything is charged.
 *
 * Until 24 Sep 2026 DMS charged a hosting line at whatever `price` the browser
 * sent — `lib/services/payment/price-verifier.ts` verifies domains only, and
 * says so. With the owner's decision that ResellerOS's price (plus 18% GST) is
 * the correct one, the charge has to come from the server's own source:
 * `hostingCharge()`.
 *
 * Refuse rather than correct. If the browser's figure differs from the server's
 * (a cart saved at the old DMS price, or a tampered one), the request is refused
 * with the real amount instead of silently charging a different figure from
 * the one the customer was shown. Same shape as the domain PRICE_CHANGED path.
 *
 * Trial lines are forced to ₹0: the today-charge of a trial is nothing.
 */
import type { CartItem } from "@/lib/types";
import { cartLinePrice, cycleFromMonths, hostingCharge, lineTotal } from "@/lib/pricing/hosting-price";

export type RepriceResult =
  | { ok: true }
  | { ok: false; status: number; body: { error: string; code: string; [k: string]: unknown } };

function planKeyOf(item: CartItem): string | undefined {
  const hp = item.hostingPlan as (CartItem["hostingPlan"] & { planId?: string; id?: string }) | undefined;
  return hp?.id || hp?.planId || (item as CartItem & { planId?: string }).planId;
}

/**
 * Re-prices every hosting line IN PLACE, or explains why it cannot.
 * Domain lines are untouched — the domain price verifier owns those.
 */
export function repriceHostingItems(items: CartItem[]): RepriceResult {
  for (const item of items) {
    if (item.itemType !== "hosting") continue;

    if (item.isTrial === true) {
      item.price = 0;
      continue;
    }

    const planKey = planKeyOf(item);
    const charge = hostingCharge(planKey, cycleFromMonths(item.registrationPeriod));
    if (!charge) {
      return {
        ok: false,
        status: 400,
        body: {
          error:
            `We can't take payment for the hosting plan "${planKey ?? "unknown"}" — it has no price on our ` +
            `price list. Remove it from your cart and choose Starter, Standard or Plus from ` +
            `Dashboard → Hosting → Buy hosting.`,
          code: "HOSTING_PLAN_UNPRICED",
        },
      };
    }

    const clientTotal = lineTotal(item.price, item.registrationPeriod || 1);
    if (Math.abs(clientTotal - charge.inclGst) > 0.01) {
      return {
        ok: false,
        status: 409,
        body: {
          error:
            `The price of ${charge.planName} hosting has changed to ₹${charge.inclGst.toLocaleString("en-IN")} ` +
            `(₹${charge.exGst.toLocaleString("en-IN")} + ₹${charge.gst.toLocaleString("en-IN")} GST) per ` +
            `${charge.cycle === "yearly" ? "year" : "month"}; your cart has ₹${clientTotal.toLocaleString("en-IN")}. ` +
            `Nothing was charged. Remove the hosting plan from your cart and add it again to see the current price.`,
          code: "PRICE_CHANGED",
          serverTotal: charge.inclGst,
          clientTotal,
        },
      };
    }

    item.price = cartLinePrice(charge);
    item.registrationPeriod = charge.months;
  }
  return { ok: true };
}
