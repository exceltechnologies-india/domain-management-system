import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { PricingService } from "@/lib/pricing-service";
import { formatIndianCurrency, formatIndianNumber } from "@/lib/dateUtils";
import { tldPricingCache } from "@/lib/tld-pricing-cache";
import { getSettingsMap } from "@/lib/services/settings";
import { connectToDatabase } from "@/lib/mongoose";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const user = await AuthService.getAdminFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check if caching is enabled
    await connectToDatabase();
    const cacheSettings = await getSettingsMap([
      "tld_pricing_cache_enabled",
      "tld_pricing_cache_ttl",
    ]);
    const cacheEnabled = cacheSettings.tld_pricing_cache_enabled !== false; // Default to true if not set

    if (cacheSettings.tld_pricing_cache_ttl) {
      tldPricingCache.setTTL(parseInt(String(cacheSettings.tld_pricing_cache_ttl)));
    }

    // Check cache first if enabled
    if (cacheEnabled) {
      const cachedData = await tldPricingCache.get();
      if (cachedData) {
        // Check if cached data is empty (data quality check)
        if (
          cachedData.totalCount === 0 ||
          !cachedData.tldPricing ||
          cachedData.tldPricing.length === 0
        ) {
          serverLogger.warn(
            "⚠️ [CACHE] Cached data is empty! Auto-purging and refetching..."
          );
          await tldPricingCache.purge();
          // Continue to fetch fresh data below
        } else {
          serverLogger.info(
            `✅ [ADMIN] Returning cached TLD pricing data from Redis (${cachedData.totalCount} TLDs)`
          );
          return NextResponse.json({
            success: true,
            tldPricing: cachedData.tldPricing,
            totalCount: cachedData.totalCount,
            lastUpdated: cachedData.lastUpdated,
            pricingSource: cachedData.pricingSource + " (Cached from Redis)",
            cached: true,
            cachedAt: new Date(cachedData.cachedAt).toISOString(),
          });
        }
      }
    }

    serverLogger.info(
      "💰 [ADMIN] Fetching TLD pricing from API (Customer + Reseller pricing comparison)"
    );

    // Get all domain pricing from ResellerClub API
    const pricingData = await PricingService.getDomainPricing();

    // Also populate the raw cache so the customer-facing /api/domains/pricing
    // endpoint can share this fetch instead of hitting RC separately.
    if (cacheEnabled && pricingData?.customerPricing && pricingData?.resellerPricing) {
      await tldPricingCache.setRaw({
        customerPricing: pricingData.customerPricing,
        resellerPricing: pricingData.resellerPricing,
        timestamp: pricingData.timestamp || new Date().toISOString(),
      });
    }

    // Extract TLD pricing from the response
    const tldPricing: Array<{
      tld: string;
      customerPrice: number;
      resellerPrice: number;
      currency: string;
      category: string;
      description?: string;
      margin?: number;
    }> = [];

    if (
      pricingData &&
      pricingData.customerPricing &&
      pricingData.resellerPricing
    ) {
      // Process customer pricing data
      const customerPricing = pricingData.customerPricing;
      const resellerPricing = pricingData.resellerPricing;

      // Get all unique TLDs from both customer and reseller pricing
      const allTlds = new Set([
        ...Object.keys(customerPricing),
        ...Object.keys(resellerPricing),
      ]);

      serverLogger.info(
        `🔍 [ADMIN] Processing ${allTlds.size} TLDs from API response`
      );

      // Log first 20 TLD keys to understand the naming pattern
      const tldArray = Array.from(allTlds).slice(0, 20);
      serverLogger.info(`📋 [DEBUG] First 20 TLD keys from API:`, tldArray);

      // Log sample data structure for debugging (first TLD)
      const sampleTld = tldArray[0];
      if (sampleTld) {
        serverLogger.info(
          `📋 [DEBUG] Sample TLD "${sampleTld}" structure:`,
          JSON.stringify(
            {
              customer: customerPricing[sampleTld],
              reseller: resellerPricing[sampleTld],
            },
            null,
            2
          )
        );
      }

      // Helper function to convert API TLD key to readable TLD
      const convertApiKeyToTld = (apiKey: string): string | null => {
        // Skip service entries
        if (apiKey === "privacy-protection" || apiKey === "premium_dns") {
          return null;
        }

        // Skip obscure internal codes (that don't follow the pattern)
        if (!apiKey.startsWith("dot") && !apiKey.startsWith("codot")) {
          return null;
        }

        // Convert: dotio → io, dotin → in, dotcom → com
        if (apiKey.startsWith("dot")) {
          return apiKey.replace("dot", "");
        }

        // Convert: codotde → co.de, codotuk → co.uk
        if (apiKey.startsWith("codot")) {
          const tldPart = apiKey.replace("codot", "");
          return `co.${tldPart}`;
        }

        return null;
      };

      // Process all TLDs from the API response
      for (const tld of Array.from(allTlds)) {
        try {
          // Convert API key to readable TLD
          const readableTld = convertApiKeyToTld(tld);

          // Skip if conversion failed or TLD is not recognizable
          if (!readableTld) {
            continue;
          }

          // ResellerClub returns several shapes here (top-level price string,
          // nested pricing block, numeric-keyed bundles). RcPriceNode captures
          // the recursive open structure so each `?.addnewdomain?.["1"]` read
          // stays type-safe instead of casting to `any`.
          type RcPriceNode =
            | string
            | { [k: string]: RcPriceNode | undefined };
          const customerTldData = customerPricing[tld] as RcPriceNode | undefined;
          const resellerTldData = resellerPricing[tld] as RcPriceNode | undefined;

          if (customerTldData || resellerTldData) {
            // Try multiple possible price field locations
            let customerPrice = 0;
            let resellerPrice = 0;

            // Extract customer price - structure: data.addnewdomain["1"]
            if (customerTldData) {
              if (typeof customerTldData === "object") {
                const addnew = customerTldData.addnewdomain;
                customerPrice = parseFloat(
                  String(
                    (typeof addnew === "object" ? addnew?.["1"] : addnew) ||
                      customerTldData["1"] ||
                      customerTldData.price ||
                      "0"
                  )
                );
              } else {
                customerPrice = parseFloat(String(customerTldData));
              }
            }

            // Extract reseller price - structure: data["0"].pricing.addnewdomain["1"]
            if (resellerTldData) {
              if (typeof resellerTldData === "object") {
                // Check for nested structure first
                const nestedPricing =
                  typeof resellerTldData["0"] === "object"
                    ? (resellerTldData["0"] as { pricing?: RcPriceNode }).pricing
                    : undefined;
                if (nestedPricing && typeof nestedPricing === "object") {
                  const nestedAddnew = nestedPricing.addnewdomain;
                  resellerPrice = parseFloat(
                    String(
                      (typeof nestedAddnew === "object" ? nestedAddnew?.["1"] : nestedAddnew) ||
                        nestedPricing["1"] ||
                        nestedPricing.price ||
                        "0"
                    )
                  );
                } else {
                  // Fallback to direct structure
                  const directAddnew = resellerTldData.addnewdomain;
                  resellerPrice = parseFloat(
                    String(
                      (typeof directAddnew === "object" ? directAddnew?.["1"] : directAddnew) ||
                        resellerTldData["1"] ||
                        resellerTldData.price ||
                        "0"
                    )
                  );
                }
              } else {
                resellerPrice = parseFloat(String(resellerTldData));
              }
            }

            // Ensure prices are valid numbers (not NaN)
            if (isNaN(customerPrice)) customerPrice = 0;
            if (isNaN(resellerPrice)) resellerPrice = 0;

            // Only add TLDs that have valid pricing
            if (customerPrice > 0 || resellerPrice > 0) {
              const margin =
                customerPrice > 0 && resellerPrice > 0
                  ? ((customerPrice - resellerPrice) / customerPrice) * 100
                  : 0;

              tldPricing.push({
                tld: `.${readableTld}`,
                customerPrice: customerPrice,
                resellerPrice: resellerPrice,
                currency: "INR",
                category: getTldCategory(readableTld),
                description: getTldDescription(readableTld),
                margin: margin,
              });
            }
          }
        } catch (error) {
          serverLogger.warn(
            `⚠️ [ADMIN] Failed to process pricing for TLD: ${tld}`,
            error
          );
        }
      }
    }

    // Sort by TLD name
    tldPricing.sort((a, b) => a.tld.localeCompare(b.tld));

    const totalCustomerPrice = tldPricing.reduce(
      (sum, tld) => sum + tld.customerPrice,
      0
    );
    const totalResellerPrice = tldPricing.reduce(
      (sum, tld) => sum + tld.resellerPrice,
      0
    );
    const avgMargin =
      tldPricing.length > 0
        ? tldPricing.reduce((sum, tld) => sum + (tld.margin || 0), 0) /
          tldPricing.length
        : 0;

    serverLogger.info(`✅ [ADMIN] Fetched pricing for ${tldPricing.length} TLDs`);
    serverLogger.info(
      `📊 [ADMIN] Pricing Summary: Total Customer ${formatIndianCurrency(
        totalCustomerPrice
      )}, Total Reseller ${formatIndianCurrency(
        totalResellerPrice
      )}, Avg Margin ${avgMargin > 0 ? "+" : ""}${avgMargin.toFixed(1)}%`
    );

    const responseData = {
      success: true,
      tldPricing,
      totalCount: tldPricing.length,
      lastUpdated: new Date().toISOString(),
      pricingSource: "ResellerClub API (Indian Pricing)",
      cached: false,
    };

    // Cache the data if caching is enabled AND data is valid
    if (cacheEnabled) {
      if (tldPricing.length > 0) {
        await tldPricingCache.set({
          tldPricing,
          totalCount: tldPricing.length,
          lastUpdated: responseData.lastUpdated,
          pricingSource: responseData.pricingSource,
        });
        serverLogger.info(`✅ [CACHE] Successfully cached ${tldPricing.length} TLDs`);
      } else {
        serverLogger.error(
          `❌ [CACHE] Refusing to cache empty data! Check data extraction logic.`
        );
        // Purge any existing empty cache
        await tldPricingCache.purge();
        serverLogger.info(`🗑️ [CACHE] Purged empty cache to prevent stale data`);
      }
    }

    return NextResponse.json(responseData);
  } catch (error) {
    serverLogger.error("❌ [ADMIN] Failed to fetch TLD pricing:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch TLD pricing",
      },
      { status: 500 }
    );
  }
}

// Helper function to categorize TLDs
function getTldCategory(tld: string): string {
  const categories: { [key: string]: string } = {
    // Generic TLDs
    com: "Generic",
    net: "Generic",
    org: "Generic",
    info: "Generic",
    biz: "Generic",
    name: "Generic",
    pro: "Generic",

    // Country Code TLDs
    in: "Country Code",
    "co.in": "Country Code",
    us: "Country Code",
    uk: "Country Code",
    ca: "Country Code",
    au: "Country Code",
    de: "Country Code",
    fr: "Country Code",
    it: "Country Code",
    es: "Country Code",
    nl: "Country Code",
    be: "Country Code",
    ch: "Country Code",
    at: "Country Code",
    se: "Country Code",
    no: "Country Code",
    dk: "Country Code",
    fi: "Country Code",
    pl: "Country Code",
    cz: "Country Code",
    hu: "Country Code",
    ro: "Country Code",
    bg: "Country Code",
    hr: "Country Code",
    si: "Country Code",
    sk: "Country Code",
    lt: "Country Code",
    lv: "Country Code",
    ee: "Country Code",
    lu: "Country Code",
    ie: "Country Code",
    pt: "Country Code",
    gr: "Country Code",
    cy: "Country Code",
    mt: "Country Code",
    li: "Country Code",
    is: "Country Code",
    fo: "Country Code",
    gl: "Country Code",

    // New Generic TLDs
    shop: "New Generic",
    store: "New Generic",
    online: "New Generic",
    site: "New Generic",
    website: "New Generic",
    app: "New Generic",
    dev: "New Generic",
    tech: "New Generic",
    digital: "New Generic",
    cloud: "New Generic",
    host: "New Generic",
    space: "New Generic",
    io: "New Generic",
    ai: "New Generic",
    me: "New Generic",
    tv: "New Generic",
    cc: "New Generic",
    mobi: "New Generic",
    asia: "New Generic",
    co: "New Generic",
  };

  return categories[tld] || "Other";
}

// Helper function to get TLD descriptions
function getTldDescription(tld: string): string {
  const descriptions: { [key: string]: string } = {
    com: "Commercial organizations",
    net: "Network infrastructure",
    org: "Non-profit organizations",
    info: "Informational sites",
    biz: "Business websites",
    shop: "E-commerce and shopping",
    store: "Online stores",
    online: "Online presence",
    site: "Websites and web presence",
    website: "Websites and web presence",
    app: "Applications and software",
    dev: "Development and developers",
    tech: "Technology companies",
    digital: "Digital services",
    cloud: "Cloud services",
    host: "Hosting services",
    space: "Personal and creative spaces",
    io: "Technology and startups",
    ai: "Artificial intelligence",
    me: "Personal websites",
    tv: "Television and media",
    cc: "Creative Commons",
    mobi: "Mobile websites",
    name: "Personal names",
    pro: "Professionals",
    asia: "Asia Pacific region",
    co: "Companies and corporations",
    in: "India",
    "co.in": "India commercial",
    us: "United States",
    uk: "United Kingdom",
    ca: "Canada",
    au: "Australia",
    de: "Germany",
    fr: "France",
    it: "Italy",
    es: "Spain",
    nl: "Netherlands",
    be: "Belgium",
    ch: "Switzerland",
    at: "Austria",
    se: "Sweden",
    no: "Norway",
    dk: "Denmark",
    fi: "Finland",
    pl: "Poland",
    cz: "Czech Republic",
    hu: "Hungary",
    ro: "Romania",
    bg: "Bulgaria",
    hr: "Croatia",
    si: "Slovenia",
    sk: "Slovakia",
    lt: "Lithuania",
    lv: "Latvia",
    ee: "Estonia",
    lu: "Luxembourg",
    ie: "Ireland",
    pt: "Portugal",
    gr: "Greece",
    cy: "Cyprus",
    mt: "Malta",
    li: "Liechtenstein",
    is: "Iceland",
    fo: "Faroe Islands",
    gl: "Greenland",
  };

  return descriptions[tld] || "Domain extension";
}
