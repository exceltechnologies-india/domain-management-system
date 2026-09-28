/**
 * GET /api/public/hosting-prices — ResellerOS's hosting prices, for this panel's browser.
 *
 * Owner, 28 Sep 2026: "Read prices live from ResellerOS". The panel's plan cards, trial
 * line and upsell read this instead of a copy. Public because list prices are public (the
 * ResellerOS /hosting page shows them). When ResellerOS cannot be read: 503 with a sentence
 * for the customer, never a fallback price (AGENTS.md §2).
 */
import { secureJsonResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { fetchHostingPrices, HOSTING_PRICES_UNAVAILABLE } from "@/lib/reselleros/hosting-prices";

export const dynamic = "force-dynamic";

export async function GET() {
  const out = await fetchHostingPrices();
  if (out.ok) return secureJsonResponse({ state: "ok", table: out.table });
  serverLogger.error(`[hosting-prices] ${out.detail}. Hosting cannot be priced in the panel until ResellerOS answers.`);
  return secureJsonResponse({ state: "unavailable", message: HOSTING_PRICES_UNAVAILABLE }, 503);
}
