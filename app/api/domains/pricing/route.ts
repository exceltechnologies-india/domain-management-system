import { NextRequest, NextResponse } from "next/server";
import { ResellerClubAPI } from "@/lib/resellerclub";
import { rateLimiters } from "@/lib/rate-limit";
import { serverLogger } from "@/lib/server-logger";
import { tldPricingCache } from "@/lib/tld-pricing-cache";
import { getSettingsMap } from "@/lib/services/settings";
import { connectToDatabase } from "@/lib/mongoose";

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

/**
 * Customer-facing domain pricing endpoint.
 *
 * Reads from the same Redis cache the admin TLD pricing page populates
 * (`tldPricingCache.getRaw()`), so one RC fetch per cache-TTL window
 * serves the entire app. Falls back to a fresh RC call on cache miss.
 *
 * NOTE: This endpoint is for DISPLAY. Payment routes (`/api/payments/create-order`)
 * intentionally bypass this cache and call RC live via `verifyDomainPrices()` —
 * never trust cached prices when actually charging a customer.
 */
export async function GET(request: NextRequest) {
  const startTime = Date.now();
  const requestId = Math.random().toString(36).substring(7);

  try {
    const rateLimit = await rateLimiters.domainPricing.isAllowed(request);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { success: false, error: "Too many requests. Please slow down.", requestId },
        { status: 429 }
      );
    }

    const { searchParams } = new URL(request.url);
    const tldsParam = searchParams.get("tlds");
    const tlds = tldsParam ? tldsParam.split(",").map((tld) => tld.trim()) : [];

    // Specific TLD pricing requests bypass the cache — different API path,
    // and these are usually called for fresh quotes.
    if (tlds.length > 0) {
      serverLogger.info(`💰 [API-${requestId}] Live pricing request for ${tlds.length} TLD(s)`);
      const pricingData = await ResellerClubAPI.getTLDPricing(tlds);
      const responseTime = Date.now() - startTime;
      return NextResponse.json({
        success: true,
        data: pricingData,
        requestId,
        responseTime: `${responseTime}ms`,
        cached: false,
      });
    }

    // Full-pricing request — check Redis cache first.
    let cacheEnabled = true;
    try {
      await connectToDatabase();
      const settings = await getSettingsMap(["tld_pricing_cache_enabled", "tld_pricing_cache_ttl"]);
      if ("tld_pricing_cache_enabled" in settings) {
        cacheEnabled = settings.tld_pricing_cache_enabled !== false;
      }
      if (settings.tld_pricing_cache_ttl) {
        tldPricingCache.setTTL(parseInt(String(settings.tld_pricing_cache_ttl)));
      }
    } catch {
      // DB hiccup — keep going with defaults.
    }

    if (cacheEnabled) {
      const cached = await tldPricingCache.getRaw();
      if (cached) {
        const responseTime = Date.now() - startTime;
        serverLogger.info(
          `💰 [API-${requestId}] Served pricing from Redis cache in ${responseTime}ms`
        );
        return NextResponse.json({
          success: true,
          data: {
            customerPricing: cached.customerPricing,
            resellerPricing: cached.resellerPricing,
            timestamp: cached.timestamp,
          },
          requestId,
          responseTime: `${responseTime}ms`,
          cached: true,
        });
      }
    }

    // Cache miss — fetch fresh from RC and populate cache.
    serverLogger.info(`💰 [API-${requestId}] Cache miss — fetching live pricing from RC`);
    const pricingData = await ResellerClubAPI.getDomainPricing();

    if (cacheEnabled && pricingData?.customerPricing && pricingData?.resellerPricing) {
      await tldPricingCache.setRaw({
        customerPricing: pricingData.customerPricing,
        resellerPricing: pricingData.resellerPricing,
        timestamp: pricingData.timestamp || new Date().toISOString(),
      });
    }

    const responseTime = Date.now() - startTime;
    return NextResponse.json({
      success: true,
      data: pricingData,
      requestId,
      responseTime: `${responseTime}ms`,
      cached: false,
    });
  } catch (error) {
    const responseTime = Date.now() - startTime;
    serverLogger.error(`❌ [API-${requestId}] Failed to fetch pricing data:`, {
      error: error instanceof Error ? error.message : "Unknown error",
      responseTime: `${responseTime}ms`,
    });

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch pricing data",
        requestId,
        responseTime: `${responseTime}ms`,
      },
      { status: 500 }
    );
  }
}
