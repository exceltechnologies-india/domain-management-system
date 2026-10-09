/**
 * GET /api/public/domain-term-prices?domain=example.in — what ResellerOS charges for that
 * domain per term (1, 2, 3, 5 years), before GST, for the portal cart (9 Oct 2026).
 *
 * Public, like /api/public/hosting-prices: these are the list prices the ResellerOS site's
 * search shows to anyone. When ResellerOS cannot be read: 503 with a sentence for the
 * customer, never a made-up price (AGENTS.md §2).
 */
import type { NextRequest } from "next/server";
import { secureJsonResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { DOMAIN_PRICE_UNAVAILABLE, fetchDomainTermPrices, splitDomainName } from "@/lib/reselleros/domain-term-prices";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const domain = (req.nextUrl.searchParams.get("domain") ?? "").trim().toLowerCase();
  if (!splitDomainName(domain)) {
    return secureJsonResponse({ state: "invalid", message: "Give one domain name, like example.in." }, 400);
  }
  const out = await fetchDomainTermPrices(domain);
  if (out.ok) return secureJsonResponse({ state: "ok", domain: out.domain, totals: out.totals, gstRate: 0.18 });
  serverLogger.error(`[domain-term-prices] ${out.detail}. The cart shows an estimate for ${domain}.`);
  return secureJsonResponse({ state: "unavailable", message: DOMAIN_PRICE_UNAVAILABLE }, 503);
}
