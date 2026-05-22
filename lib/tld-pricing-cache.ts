/**
 * TLD Pricing Cache Service
 *
 * Provides Redis caching for TLD pricing data to reduce API calls
 * and improve performance.
 */

import { redisCache, redis } from "@/lib/redis";
import { serverLogger } from "@/lib/server-logger";

interface CachedPricingData {
  tldPricing: Array<{
    tld: string;
    customerPrice: number;
    resellerPrice: number;
    currency: string;
    category: string;
    description?: string;
    margin?: number;
  }>;
  totalCount: number;
  lastUpdated: string;
  pricingSource: string;
  cachedAt: number;
}

/**
 * Raw RC pricing payload — what the customer-facing /api/domains/pricing
 * endpoint returns. Stored separately so the admin "processed" view and the
 * customer "raw" view can share the same upstream fetch.
 */
interface RawCachedPricing {
  customerPricing: unknown;
  resellerPricing: unknown;
  timestamp: string;
  cachedAt: number;
}

class TLDPricingCacheService {
  private defaultTTL: number = 60; // 60 minutes default
  private readonly CACHE_KEY = "tld_pricing_cache";
  private readonly RAW_CACHE_KEY = "tld_pricing_raw_cache";

  /**
   * Get cached pricing data if available and not expired
   */
  async get(): Promise<CachedPricingData | null> {
    try {
      const cache = await redisCache.get<CachedPricingData>(this.CACHE_KEY);
      
      if (!cache) {
        return null;
      }

      return cache;
    } catch (error) {
      serverLogger.error("[CACHE] Error reading from Redis:", error);
      return null;
    }
  }

  /**
   * Set pricing data in cache
   */
  async set(data: Omit<CachedPricingData, "cachedAt">): Promise<void> {
    try {
      const cachedData: CachedPricingData = {
        ...data,
        cachedAt: Date.now(),
      };

      // Set in Redis with TTL in seconds
      await redisCache.set(this.CACHE_KEY, cachedData, this.defaultTTL * 60);
      serverLogger.info(`✅ [CACHE] Saved ${data.totalCount} TLDs to Redis with ${this.defaultTTL}m TTL`);
    } catch (error) {
      serverLogger.error("[CACHE] Error saving to Redis:", error);
    }
  }

  /**
   * Manually purge the cache (both processed + raw).
   */
  async purge(): Promise<void> {
    try {
      await redisCache.del(this.CACHE_KEY);
      await redisCache.del(this.RAW_CACHE_KEY);
      serverLogger.info("🗑️ [CACHE] Cache purged from Redis (processed + raw)");
    } catch (error) {
      serverLogger.error("[CACHE] Error purging cache:", error);
    }
  }

  /**
   * Get raw RC pricing payload (shape matches /api/domains/pricing response).
   * Used by the customer-facing pricing endpoint so it can share the same
   * upstream RC fetch as the admin view.
   */
  async getRaw(): Promise<RawCachedPricing | null> {
    try {
      return await redisCache.get<RawCachedPricing>(this.RAW_CACHE_KEY);
    } catch (error) {
      serverLogger.error("[CACHE] Error reading raw pricing from Redis:", error);
      return null;
    }
  }

  /**
   * Store raw RC pricing payload. Both `set()` and `setRaw()` should be
   * called together when fetching fresh data so the processed + raw views
   * stay in sync.
   */
  async setRaw(data: Omit<RawCachedPricing, "cachedAt">): Promise<void> {
    try {
      const cached: RawCachedPricing = { ...data, cachedAt: Date.now() };
      await redisCache.set(this.RAW_CACHE_KEY, cached, this.defaultTTL * 60);
      serverLogger.info(`✅ [CACHE] Saved raw RC pricing to Redis with ${this.defaultTTL}m TTL`);
    } catch (error) {
      serverLogger.error("[CACHE] Error saving raw pricing to Redis:", error);
    }
  }

  /**
   * Check if cache exists and is valid
   */
  async isValid(): Promise<boolean> {
    if (!redis) return false;
    try {
      const exists = await redis.exists(this.CACHE_KEY);
      return exists === 1;
    } catch (error) {
      serverLogger.error("[CACHE] Error checking cache validity:", error);
      return false;
    }
  }

  /**
   * Get cache status information
   */
  async getStatus(): Promise<{
    isCached: boolean;
    hasData: boolean;
    cachedAt: string | null;
    expiresAt: string | null;
    remainingTime: number | null;
    itemCount: number | null;
    isRedis: boolean;
  }> {
    try {
      const cache = await redisCache.get<CachedPricingData>(this.CACHE_KEY);

      if (!cache) {
        return {
          isCached: false,
          hasData: false,
          cachedAt: null,
          expiresAt: null,
          remainingTime: null,
          itemCount: null,
          isRedis: !!process.env.REDIS_HOST,
        };
      }

      // Get remaining TTL from Redis (in seconds). If REDIS_HOST isn't
      // configured, `cache` would already have returned null above, so
      // `redis` is guaranteed non-null here — but be defensive.
      const remainingTimeInSeconds = redis ? await redis.ttl(this.CACHE_KEY) : 0;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + remainingTimeInSeconds * 1000);

      return {
        isCached: true,
        hasData: true,
        cachedAt: new Date(cache.cachedAt).toISOString(),
        expiresAt: expiresAt.toISOString(),
        remainingTime: remainingTimeInSeconds,
        itemCount: cache.totalCount,
        isRedis: true,
      };
    } catch (error) {
      serverLogger.error("[CACHE] Error getting cache status:", error);
      return {
        isCached: false,
        hasData: false,
        cachedAt: null,
        expiresAt: null,
        remainingTime: null,
        itemCount: null,
        isRedis: !!process.env.REDIS_HOST,
      };
    }
  }

  /**
   * Update cache TTL
   */
  setTTL(ttlInMinutes: number): void {
    this.defaultTTL = ttlInMinutes;
    serverLogger.info(`⏱️ [CACHE] Updated cache TTL to ${ttlInMinutes} minutes`);
  }

  /**
   * Get current TTL in minutes
   */
  getTTL(): number {
    return this.defaultTTL;
  }
}

// Export singleton instance
export const tldPricingCache = new TLDPricingCacheService();
