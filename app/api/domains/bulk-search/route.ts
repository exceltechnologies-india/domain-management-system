import { NextRequest, NextResponse } from "next/server";
import { ResellerClubAPI } from "@/lib/resellerclub";
import { rateLimiters, rateLimitResponse } from "@/lib/rate-limit";
import { serverLogger } from "@/lib/server-logger";
import { isRestrictedTLD } from "@/lib/domainRequirements";
import { validatedBody, z } from "@/lib/api-validation";

export const dynamic = "force-dynamic";

const MAX_DOMAINS = 20;

const bulkSearchSchema = z.object({
  // Cap at MAX_DOMAINS × 3 so a client that sends dupes (which the route
  // dedupes downstream) still falls within Zod limits.
  domains: z
    .array(z.string().max(253))
    .min(1, "Provide a list of domain names to search.")
    .max(MAX_DOMAINS * 3),
});

export interface BulkSearchResult {
  domainName: string;
  available: boolean;
  price: number;
  currency: string;
  registrationPeriod: number;
  pricingSource?: string;
  restricted?: boolean;
  error?: string;
}

export async function POST(request: NextRequest) {
  try {
    const rateLimit = await rateLimiters.bulkDomainSearch.isAllowed(request);
    if (!rateLimit.allowed) {
      return rateLimitResponse(rateLimit, {
        limit: 5,
        message: "Too many requests. Please wait a moment before searching again.",
      });
    }

    const validation = await validatedBody(request, bulkSearchSchema);
    if (!validation.ok) return validation.response;
    const { domains } = validation.data;

    // Sanitise and deduplicate (Zod guarantees each element is a string)
    const cleaned = [
      ...new Set(
        domains
          .map((d) => d.trim().toLowerCase())
          .filter((d) => d.length > 0 && d.includes("."))
      ),
    ].slice(0, MAX_DOMAINS);

    if (cleaned.length === 0) {
      return NextResponse.json(
        { success: false, error: "No valid domain names provided. Each entry must include a TLD (e.g. example.com)." },
        { status: 400 }
      );
    }

    serverLogger.info(`[BULK-SEARCH] Checking ${cleaned.length} domains`);

    const settled = await Promise.allSettled(
      cleaned.map(async (domain): Promise<BulkSearchResult> => {
        const tld = domain.split(".").slice(1).join(".");
        if (isRestrictedTLD(`.${tld}`)) {
          return {
            domainName: domain,
            available: false,
            price: 0,
            currency: "INR",
            registrationPeriod: 1,
            restricted: true,
          };
        }

        const results = await ResellerClubAPI.searchDomain(domain);
        const match = results.find(
          (r) => r.domainName.toLowerCase() === domain
        ) ?? results[0];

        if (!match) {
          return {
            domainName: domain,
            available: false,
            price: 0,
            currency: "INR",
            registrationPeriod: 1,
            error: "No result returned",
          };
        }

        return {
          domainName: match.domainName,
          available: match.available,
          price: match.price,
          currency: match.currency,
          registrationPeriod: match.registrationPeriod,
          pricingSource: match.pricingSource,
        };
      })
    );

    const results: BulkSearchResult[] = settled.map((outcome, i) => {
      if (outcome.status === "fulfilled") return outcome.value;
      serverLogger.error(`[BULK-SEARCH] Error for ${cleaned[i]}:`, outcome.reason);
      return {
        domainName: cleaned[i],
        available: false,
        price: 0,
        currency: "INR",
        registrationPeriod: 1,
        error: "Availability check failed",
      };
    });

    return NextResponse.json({ success: true, results });
  } catch (error) {
    serverLogger.error("[BULK-SEARCH] Unexpected error:", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
