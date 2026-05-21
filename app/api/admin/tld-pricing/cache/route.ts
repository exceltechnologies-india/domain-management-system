import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { tldPricingCache } from "@/lib/tld-pricing-cache";
import { upsertSetting } from "@/lib/services/settings";
import { connectToDatabase } from "@/lib/mongoose";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/tld-pricing/cache
 * Get cache status
 */
export async function GET(request: NextRequest) {
  try {
    await connectToDatabase();

    const user = await AuthService.getAdminFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const cacheStatus = await tldPricingCache.getStatus();

    return NextResponse.json({
      success: true,
      cache: cacheStatus,
      ttl: tldPricingCache.getTTL(),
    });
  } catch (error) {
    serverLogger.error("[CACHE-API] Error getting cache status:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to get cache status",
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/admin/tld-pricing/cache
 * Purge the cache
 */
export async function DELETE(request: NextRequest) {
  try {
    await connectToDatabase();

    const user = await AuthService.getAdminFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await tldPricingCache.purge();

    serverLogger.info(`🗑️ [CACHE-API] Cache purged by admin: ${user.email}`);

    return NextResponse.json({
      success: true,
      message: "Cache purged successfully",
    });
  } catch (error) {
    serverLogger.error("[CACHE-API] Error purging cache:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to purge cache",
      },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/admin/tld-pricing/cache
 * Update cache settings (enable/disable, TTL)
 */
export async function PUT(request: NextRequest) {
  try {
    await connectToDatabase();

    const user = await AuthService.getAdminFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { enabled, ttlMinutes } = body;

    // Update cache enabled setting
    if (enabled !== undefined) {
      await upsertSetting("tld_pricing_cache_enabled", enabled, {
        description: "Enable/disable TLD pricing cache",
        category: "caching",
        updatedBy: user.email,
      });

      serverLogger.info(
        `⚙️ [CACHE-API] Cache ${enabled ? "enabled" : "disabled"} by admin: ${
          user.email
        }`
      );

      // If disabling, purge the cache
      if (!enabled) {
        await tldPricingCache.purge();
      }
    }

    // Update TTL setting
    if (ttlMinutes !== undefined && ttlMinutes > 0) {
      await upsertSetting("tld_pricing_cache_ttl", ttlMinutes, {
        description: "TLD pricing cache TTL in minutes",
        category: "caching",
        updatedBy: user.email,
      });

      tldPricingCache.setTTL(ttlMinutes);
      serverLogger.info(
        `⏱️ [CACHE-API] Cache TTL updated to ${ttlMinutes} minutes by admin: ${user.email}`
      );
    }

    return NextResponse.json({
      success: true,
      message: "Cache settings updated successfully",
      settings: {
        enabled,
        ttlMinutes,
      },
    });
  } catch (error) {
    serverLogger.error("[CACHE-API] Error updating cache settings:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to update cache settings",
      },
      { status: 500 }
    );
  }
}
