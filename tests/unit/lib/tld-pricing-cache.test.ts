/**
 * Tests for `@/lib/tld-pricing-cache` (rescan-4 slice 7fk).
 * Redis-backed cache for TLD pricing data — feeds both the customer-
 * facing `/api/domains/pricing` endpoint and the admin pricing view.
 * Pins:
 *  - `get()` reads CACHE_KEY from redisCache; cache miss → null;
 *    redis throw → returns null (caller falls through to fresh fetch)
 *  - `set()` stamps cachedAt:Date.now() onto stored payload + TTL in
 *    SECONDS = defaultTTL × 60 (defaultTTL is in MINUTES — 60 min default)
 *  - set/setRaw throws SWALLOWED (cache is best-effort; never blocks
 *    the calling fetch path)
 *  - `purge()` deletes BOTH CACHE_KEY and RAW_CACHE_KEY (processed +
 *    raw views must stay in sync — purging one without the other would
 *    leave the admin/customer views looking at different snapshots)
 *  - `getRaw()` reads the separate RAW_CACHE_KEY (customer endpoint
 *    shares the upstream fetch via this raw view)
 *  - `isValid()`: redis-null → false; EXISTS === 1 → true; throw → false
 *  - **getStatus** shape: cache miss → all-null fields with isRedis from
 *    env; cache hit → cachedAt + expiresAt (now + ttl seconds) + remaining
 *    in seconds + itemCount; redis-error swallowed → returns the miss shape
 *  - `setTTL` mutates the in-memory default; subsequent `set()` uses it
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const redisCacheGet = vi.hoisted(() => vi.fn());
const redisCacheSet = vi.hoisted(() => vi.fn());
const redisCacheDel = vi.hoisted(() => vi.fn());
const redisExists = vi.hoisted(() => vi.fn());
const redisTtl = vi.hoisted(() => vi.fn());
const redisStub = vi.hoisted(() => ({
  exists: redisExists,
  ttl: redisTtl,
}));
vi.mock("@/lib/redis", () => ({
  redisCache: { get: redisCacheGet, set: redisCacheSet, del: redisCacheDel },
  redis: redisStub,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { tldPricingCache } from "@/lib/tld-pricing-cache";

beforeEach(() => {
  redisCacheGet.mockReset();
  redisCacheSet.mockReset();
  redisCacheDel.mockReset();
  redisExists.mockReset();
  redisTtl.mockReset();
  // Reset TTL between tests (singleton state).
  tldPricingCache.setTTL(60);
  vi.stubEnv("REDIS_HOST", "redis.test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const SAMPLE_DATA = {
  tldPricing: [
    {
      tld: "com",
      customerPrice: 999,
      resellerPrice: 850,
      currency: "INR",
      category: "popular",
    },
  ],
  totalCount: 1,
  lastUpdated: "2026-06-01T00:00:00.000Z",
  pricingSource: "resellerclub",
};

describe("get() — read CACHE_KEY", () => {
  it("hit: returns the cached payload as-is", async () => {
    const stored = { ...SAMPLE_DATA, cachedAt: 1700000000000 };
    redisCacheGet.mockResolvedValueOnce(stored);
    expect(await tldPricingCache.get()).toEqual(stored);
    expect(redisCacheGet).toHaveBeenCalledWith("tld_pricing_cache");
  });

  it("miss: returns null", async () => {
    redisCacheGet.mockResolvedValueOnce(null);
    expect(await tldPricingCache.get()).toBeNull();
  });

  it("Redis throw → null (caller falls through to fresh fetch)", async () => {
    redisCacheGet.mockRejectedValueOnce(new Error("redis down"));
    expect(await tldPricingCache.get()).toBeNull();
  });
});

describe("set() — write CACHE_KEY with TTL in seconds", () => {
  it("stamps cachedAt + uses defaultTTL × 60 seconds (default 60min → 3600s)", async () => {
    const before = Date.now();
    await tldPricingCache.set(SAMPLE_DATA);
    const [key, value, ttl] = redisCacheSet.mock.calls[0];
    expect(key).toBe("tld_pricing_cache");
    expect(value).toEqual({
      ...SAMPLE_DATA,
      cachedAt: expect.any(Number),
    });
    expect((value as { cachedAt: number }).cachedAt).toBeGreaterThanOrEqual(before);
    expect(ttl).toBe(3600); // 60 min × 60 sec
  });

  it("setTTL(15) → next set() uses 900s (15min × 60)", async () => {
    tldPricingCache.setTTL(15);
    await tldPricingCache.set(SAMPLE_DATA);
    const [, , ttl] = redisCacheSet.mock.calls[0];
    expect(ttl).toBe(900);
  });

  it("Redis throw SWALLOWED (cache is best-effort)", async () => {
    redisCacheSet.mockRejectedValueOnce(new Error("redis down"));
    await expect(tldPricingCache.set(SAMPLE_DATA)).resolves.toBeUndefined();
  });
});

describe("purge() — deletes BOTH processed + raw keys", () => {
  it("deletes CACHE_KEY AND RAW_CACHE_KEY together (sync invariant)", async () => {
    redisCacheDel.mockResolvedValue(1);
    await tldPricingCache.purge();
    expect(redisCacheDel).toHaveBeenCalledTimes(2);
    expect(redisCacheDel).toHaveBeenCalledWith("tld_pricing_cache");
    expect(redisCacheDel).toHaveBeenCalledWith("tld_pricing_raw_cache");
  });

  it("Redis throw SWALLOWED", async () => {
    redisCacheDel.mockRejectedValueOnce(new Error("redis down"));
    await expect(tldPricingCache.purge()).resolves.toBeUndefined();
  });
});

describe("getRaw() / setRaw() — separate RAW_CACHE_KEY", () => {
  it("getRaw reads RAW_CACHE_KEY (distinct from processed view)", async () => {
    redisCacheGet.mockResolvedValueOnce(null);
    await tldPricingCache.getRaw();
    expect(redisCacheGet).toHaveBeenCalledWith("tld_pricing_raw_cache");
  });

  it("setRaw stamps cachedAt + same TTL × 60 contract", async () => {
    await tldPricingCache.setRaw({
      customerPricing: { com: {} },
      resellerPricing: { com: {} },
      timestamp: "2026-06-01T00:00:00.000Z",
    });
    const [key, value, ttl] = redisCacheSet.mock.calls[0];
    expect(key).toBe("tld_pricing_raw_cache");
    expect((value as { cachedAt: number }).cachedAt).toEqual(expect.any(Number));
    expect(ttl).toBe(3600);
  });

  it("getRaw throw → null", async () => {
    redisCacheGet.mockRejectedValueOnce(new Error("redis down"));
    expect(await tldPricingCache.getRaw()).toBeNull();
  });
});

describe("isValid()", () => {
  it("EXISTS === 1 → true", async () => {
    redisExists.mockResolvedValueOnce(1);
    expect(await tldPricingCache.isValid()).toBe(true);
    expect(redisExists).toHaveBeenCalledWith("tld_pricing_cache");
  });

  it("EXISTS === 0 → false", async () => {
    redisExists.mockResolvedValueOnce(0);
    expect(await tldPricingCache.isValid()).toBe(false);
  });

  it("redis throw → false (safe default)", async () => {
    redisExists.mockRejectedValueOnce(new Error("redis down"));
    expect(await tldPricingCache.isValid()).toBe(false);
  });
});

describe("getStatus() — shape contract", () => {
  it("cache miss → all-null fields + isRedis from env REDIS_HOST", async () => {
    redisCacheGet.mockResolvedValueOnce(null);
    const status = await tldPricingCache.getStatus();
    expect(status).toEqual({
      isCached: false,
      hasData: false,
      cachedAt: null,
      expiresAt: null,
      remainingTime: null,
      itemCount: null,
      isRedis: true, // env stubbed in beforeEach
    });
  });

  it("REDIS_HOST unset → isRedis:false in miss shape", async () => {
    vi.stubEnv("REDIS_HOST", "");
    redisCacheGet.mockResolvedValueOnce(null);
    const status = await tldPricingCache.getStatus();
    expect(status.isRedis).toBe(false);
  });

  it("cache hit: cachedAt + expiresAt + remainingTime + itemCount", async () => {
    const cachedAt = new Date("2026-06-01T00:00:00.000Z").getTime();
    redisCacheGet.mockResolvedValueOnce({
      ...SAMPLE_DATA,
      cachedAt,
    });
    redisTtl.mockResolvedValueOnce(3000); // 3000 sec remaining
    const status = await tldPricingCache.getStatus();
    expect(status.isCached).toBe(true);
    expect(status.hasData).toBe(true);
    expect(status.cachedAt).toBe("2026-06-01T00:00:00.000Z");
    expect(status.remainingTime).toBe(3000);
    expect(status.itemCount).toBe(1);
    expect(status.isRedis).toBe(true);
  });

  it("redis throw inside status → safe miss-shape default (not bubbled)", async () => {
    redisCacheGet.mockRejectedValueOnce(new Error("redis down"));
    const status = await tldPricingCache.getStatus();
    expect(status.isCached).toBe(false);
    expect(status.hasData).toBe(false);
  });
});

describe("setTTL / getTTL", () => {
  it("setTTL(45) → getTTL() returns 45 (minutes)", () => {
    tldPricingCache.setTTL(45);
    expect(tldPricingCache.getTTL()).toBe(45);
  });

  it("default TTL is 60 minutes", () => {
    // We reset to 60 in beforeEach.
    expect(tldPricingCache.getTTL()).toBe(60);
  });
});
