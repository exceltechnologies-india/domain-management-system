import { AUTH_SECRET } from "@/lib/auth-secret";
import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { getToken } from "next-auth/jwt";
import { tldPricingCache } from "@/lib/tld-pricing-cache";
import Settings from "@/models/Settings";
import { connectToDatabase } from "@/lib/mongoose";
import User from "@/models/User";
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

    // Try JWT first, then NextAuth session
    let user = await AuthService.getUserFromRequest(request);

    // If no user from JWT, try NextAuth session via getToken (works with cookies)
    if (!user) {
      const token = await getToken({
        req: request,
        secret: AUTH_SECRET,
      });

      if (token?.id) {
        // Get user by id from NextAuth token
        user = await User.findById(token.id).select("-password");

        if (!user || !user.isActive) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
      }
    }

    // Check admin authentication
    if (!user || user.role !== "admin") {
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

    // Try JWT first, then NextAuth session
    let user = await AuthService.getUserFromRequest(request);

    // If no user from JWT, try NextAuth session via getToken (works with cookies)
    if (!user) {
      const token = await getToken({
        req: request,
        secret: AUTH_SECRET,
      });

      if (token?.id) {
        // Get user by id from NextAuth token
        user = await User.findById(token.id).select("-password");

        if (!user || !user.isActive) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
      }
    }

    // Check admin authentication
    if (!user || user.role !== "admin") {
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

    // Try JWT first, then NextAuth session
    let user = await AuthService.getUserFromRequest(request);

    // If no user from JWT, try NextAuth session via getToken (works with cookies)
    if (!user) {
      const token = await getToken({
        req: request,
        secret: AUTH_SECRET,
      });

      if (token?.id) {
        // Get user by id from NextAuth token
        user = await User.findById(token.id).select("-password");

        if (!user || !user.isActive) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
      }
    }

    // Check admin authentication
    if (!user || user.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { enabled, ttlMinutes } = body;

    // Update cache enabled setting
    if (enabled !== undefined) {
      await Settings.findOneAndUpdate(
        { key: "tld_pricing_cache_enabled" },
        {
          key: "tld_pricing_cache_enabled",
          value: enabled,
          description: "Enable/disable TLD pricing cache",
          category: "caching",
          updatedAt: new Date(),
          updatedBy: user.email,
        },
        { upsert: true, new: true }
      );

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
      await Settings.findOneAndUpdate(
        { key: "tld_pricing_cache_ttl" },
        {
          key: "tld_pricing_cache_ttl",
          value: ttlMinutes,
          description: "TLD pricing cache TTL in minutes",
          category: "caching",
          updatedAt: new Date(),
          updatedBy: user.email,
        },
        { upsert: true, new: true }
      );

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
