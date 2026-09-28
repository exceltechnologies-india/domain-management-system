/**
 * ResellerOS's `GET /api/public/hosting-prices` body as it answers on 28 Sep 2026 (LANDING_PLANS
 * 49.99 / 125 / 187.2 per month on yearly billing; yearly = × 12, monthly = × 2, both rounded to
 * whole rupees, then + 18% GST, rounded). Tests use this instead of a copy inside the app: DMS
 * keeps no prices of its own (owner, 28 Sep 2026). ResellerOS's own test
 * (lib/checkout/hosting-prices.test.ts) pins the same Starter figures from its side.
 */
import type { HostingPriceTable } from "@/lib/pricing/hosting-price";

export const PRICE_TABLE: HostingPriceTable = {
  gstRate: 0.18,
  plans: [
    { id: "starter", name: "Starter", perMonthYearly: 49.99, yearly: { months: 12, exGst: 600, inclGst: 708 }, monthly: { months: 1, exGst: 100, inclGst: 118 } },
    { id: "standard", name: "Standard", perMonthYearly: 125, yearly: { months: 12, exGst: 1500, inclGst: 1770 }, monthly: { months: 1, exGst: 250, inclGst: 295 } },
    { id: "plus", name: "Plus", perMonthYearly: 187.2, yearly: { months: 12, exGst: 2246, inclGst: 2650 }, monthly: { months: 1, exGst: 374, inclGst: 441 } },
  ],
};
