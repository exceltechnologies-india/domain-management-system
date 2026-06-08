/**
 * Tests for `app/api/domains/pricing/route.ts` (slice 7gb). Customer-
 * facing pricing endpoint. Reads from the same Redis cache the admin
 * TLD pricing page populates so one RC fetch per cache-TTL window
 * serves the entire app.
 *
 * **Important: this is the DISPLAY endpoint. Payment routes intentionally
 * bypass this cache and call RC live — never trust cached prices when
 * actually charging.**
 *
 * Pins:
 *  - Rate-limit FIRST (30 req/min IP cap — 'Too many requests' message)
 *  - Specific-TLD lookup (?tlds=com,net): bypasses cache entirely, calls
 *    `ResellerClubAPI.getTLDPricing` live, returns cached:false
 *  - Specific-TLD parsing: comma-split + trim each entry
 *  - Full-pricing request: checks `tld_pricing_cache_enabled` and
 *    `tld_pricing_cache_ttl` from settings; defaults to enabled=true
 *  - cacheEnabled === false short-circuits straight to RC fetch (no
 *    cache.getRaw or setRaw call)
 *  - **Settings lookup DB failure is swallowed** (keeps cacheEnabled=true,
 *    keeps going — pricing must not block on a DB hiccup)
 *  - Cache HIT (raw) → returns customerPricing + resellerPricing + timestamp
 *    from cache, cached:true
 *  - Cache MISS → fetches live from RC, populates raw cache when payload
 *    is complete, returns cached:false
 *  - Cache populate skipped if RC payload missing customerPricing OR
 *    resellerPricing (anti-cache-pollution)
 *  - Cache populate skipped when cacheEnabled=false
 *  - timestamp fallback to `new Date().toISOString()` when RC omits it
 *  - 500 on RC throw (error message echoed verbatim — for ops triage)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const isAllowed = vi.hoisted(() => vi.fn());
const rateLimitResponse = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rate-limit", () => ({
  rateLimiters: { domainPricing: { isAllowed } },
  rateLimitResponse,
}));

const getTLDPricing = vi.hoisted(() => vi.fn());
const getDomainPricing = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub", () => ({
  ResellerClubAPI: { getTLDPricing, getDomainPricing },
}));

const cacheGetRaw = vi.hoisted(() => vi.fn());
const cacheSetRaw = vi.hoisted(() => vi.fn());
const cacheSetTTL = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tld-pricing-cache", () => ({
  tldPricingCache: {
    getRaw: cacheGetRaw,
    setRaw: cacheSetRaw,
    setTTL: cacheSetTTL,
  },
}));

const getSettingsMap = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/settings", () => ({ getSettingsMap }));

const connectToDatabase = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongoose", () => ({ connectToDatabase }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/domains/pricing/route";

function makeReq(qs = "") {
  const url = qs
    ? `https://example.com/api/domains/pricing?${qs}`
    : "https://example.com/api/domains/pricing";
  return new NextRequest(url, { method: "GET" });
}

beforeEach(() => {
  isAllowed.mockReset().mockResolvedValue({ allowed: true });
  rateLimitResponse.mockReset();
  getTLDPricing.mockReset();
  getDomainPricing.mockReset();
  cacheGetRaw.mockReset();
  cacheSetRaw.mockReset();
  cacheSetTTL.mockReset();
  getSettingsMap.mockReset().mockResolvedValue({});
  connectToDatabase.mockReset().mockResolvedValue(undefined);
});

// ─── Rate limit ────────────────────────────────────────────────────
describe("Rate limit FIRST", () => {
  it("over limit → rateLimitResponse called with limit:30 + 'Too many' message; NO downstream", async () => {
    isAllowed.mockResolvedValueOnce({ allowed: false });
    const rlRes = new Response(JSON.stringify({ error: "rate limited" }), {
      status: 429,
    });
    rateLimitResponse.mockReturnValueOnce(rlRes);

    const res = await GET(makeReq());
    expect(res).toBe(rlRes);
    expect(rateLimitResponse).toHaveBeenCalledWith(
      { allowed: false },
      { limit: 30, message: "Too many requests. Please slow down." }
    );
    expect(getTLDPricing).not.toHaveBeenCalled();
    expect(getDomainPricing).not.toHaveBeenCalled();
    expect(cacheGetRaw).not.toHaveBeenCalled();
  });
});

// ─── Specific-TLD lookup (cache bypass) ────────────────────────────
describe("Specific-TLD lookup bypasses cache", () => {
  it("?tlds=com,net → calls ResellerClubAPI.getTLDPricing live, returns cached:false", async () => {
    const fakeData = { com: { addnewdomain: { "1": "999" } } };
    getTLDPricing.mockResolvedValueOnce(fakeData);

    const res = await GET(makeReq("tlds=com,net"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual(fakeData);
    expect(body.cached).toBe(false);
    expect(getTLDPricing).toHaveBeenCalledWith(["com", "net"]);
    expect(cacheGetRaw).not.toHaveBeenCalled();
    expect(cacheSetRaw).not.toHaveBeenCalled();
  });

  it("trims whitespace around TLDs", async () => {
    getTLDPricing.mockResolvedValueOnce({});
    await GET(makeReq("tlds=com%20,%20net%20,%20org"));
    expect(getTLDPricing).toHaveBeenCalledWith(["com", "net", "org"]);
  });

  it("includes responseTime in response", async () => {
    getTLDPricing.mockResolvedValueOnce({});
    const res = await GET(makeReq("tlds=com"));
    const body = await res.json();
    expect(body.responseTime).toMatch(/^\d+ms$/);
    expect(body.requestId).toBeTruthy();
  });
});

// ─── Settings + cache toggles ──────────────────────────────────────
describe("Settings — cache toggles", () => {
  it("settings.tld_pricing_cache_enabled === false → skip cache entirely, go straight to RC", async () => {
    getSettingsMap.mockResolvedValueOnce({
      tld_pricing_cache_enabled: false,
    });
    getDomainPricing.mockResolvedValueOnce({
      customerPricing: {},
      resellerPricing: {},
    });

    await GET(makeReq());
    expect(cacheGetRaw).not.toHaveBeenCalled();
    expect(cacheSetRaw).not.toHaveBeenCalled();
    expect(getDomainPricing).toHaveBeenCalled();
  });

  it("settings.tld_pricing_cache_ttl present → setTTL called with parsed int", async () => {
    getSettingsMap.mockResolvedValueOnce({
      tld_pricing_cache_ttl: "600",
    });
    cacheGetRaw.mockResolvedValueOnce(null);
    getDomainPricing.mockResolvedValueOnce({
      customerPricing: {},
      resellerPricing: {},
    });

    await GET(makeReq());
    expect(cacheSetTTL).toHaveBeenCalledWith(600);
  });

  it("settings missing both keys → defaults to enabled=true; setTTL not called", async () => {
    getSettingsMap.mockResolvedValueOnce({});
    cacheGetRaw.mockResolvedValueOnce(null);
    getDomainPricing.mockResolvedValueOnce({
      customerPricing: {},
      resellerPricing: {},
    });

    await GET(makeReq());
    expect(cacheSetTTL).not.toHaveBeenCalled();
    expect(cacheGetRaw).toHaveBeenCalled();
  });

  it("connectToDatabase throw → swallowed, defaults to cacheEnabled=true", async () => {
    connectToDatabase.mockRejectedValueOnce(new Error("DB down"));
    cacheGetRaw.mockResolvedValueOnce(null);
    getDomainPricing.mockResolvedValueOnce({
      customerPricing: {},
      resellerPricing: {},
    });

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    expect(cacheGetRaw).toHaveBeenCalled();
  });

  it("getSettingsMap throw → swallowed, defaults to cacheEnabled=true", async () => {
    getSettingsMap.mockRejectedValueOnce(new Error("Settings table error"));
    cacheGetRaw.mockResolvedValueOnce(null);
    getDomainPricing.mockResolvedValueOnce({
      customerPricing: {},
      resellerPricing: {},
    });

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    expect(cacheGetRaw).toHaveBeenCalled();
  });
});

// ─── Cache hit ─────────────────────────────────────────────────────
describe("Cache hit (raw)", () => {
  it("returns cached payload with cached:true; NO RC call, NO cache write", async () => {
    cacheGetRaw.mockResolvedValueOnce({
      customerPricing: { com: { price: "999" } },
      resellerPricing: { com: { price: "800" } },
      timestamp: "2026-06-04T10:00:00.000Z",
    });

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cached).toBe(true);
    expect(body.data.customerPricing).toEqual({ com: { price: "999" } });
    expect(body.data.resellerPricing).toEqual({ com: { price: "800" } });
    expect(body.data.timestamp).toBe("2026-06-04T10:00:00.000Z");
    expect(getDomainPricing).not.toHaveBeenCalled();
    expect(cacheSetRaw).not.toHaveBeenCalled();
  });
});

// ─── Cache miss → fetch + populate ─────────────────────────────────
describe("Cache miss → live fetch", () => {
  it("falls back to RC live, populates raw cache, returns cached:false", async () => {
    cacheGetRaw.mockResolvedValueOnce(null);
    const pricingData = {
      customerPricing: { com: { price: "999" } },
      resellerPricing: { com: { price: "800" } },
      timestamp: "2026-06-04T11:00:00.000Z",
    };
    getDomainPricing.mockResolvedValueOnce(pricingData);

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cached).toBe(false);
    expect(body.data).toEqual(pricingData);
    expect(cacheSetRaw).toHaveBeenCalledWith({
      customerPricing: pricingData.customerPricing,
      resellerPricing: pricingData.resellerPricing,
      timestamp: pricingData.timestamp,
    });
  });

  it("RC payload missing customerPricing → cache NOT populated (anti-cache-pollution)", async () => {
    cacheGetRaw.mockResolvedValueOnce(null);
    getDomainPricing.mockResolvedValueOnce({
      resellerPricing: { com: { price: "800" } },
      // customerPricing missing
    });

    await GET(makeReq());
    expect(cacheSetRaw).not.toHaveBeenCalled();
  });

  it("RC payload missing resellerPricing → cache NOT populated", async () => {
    cacheGetRaw.mockResolvedValueOnce(null);
    getDomainPricing.mockResolvedValueOnce({
      customerPricing: { com: { price: "999" } },
      // resellerPricing missing
    });

    await GET(makeReq());
    expect(cacheSetRaw).not.toHaveBeenCalled();
  });

  it("RC payload missing timestamp → fallback to `new Date().toISOString()`", async () => {
    cacheGetRaw.mockResolvedValueOnce(null);
    getDomainPricing.mockResolvedValueOnce({
      customerPricing: { com: { price: "999" } },
      resellerPricing: { com: { price: "800" } },
      // timestamp missing
    });

    await GET(makeReq());
    expect(cacheSetRaw).toHaveBeenCalledWith(
      expect.objectContaining({
        timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      })
    );
  });

  it("cacheEnabled=false + cache miss → fetch live but DO NOT populate cache", async () => {
    getSettingsMap.mockResolvedValueOnce({
      tld_pricing_cache_enabled: false,
    });
    getDomainPricing.mockResolvedValueOnce({
      customerPricing: { com: { price: "999" } },
      resellerPricing: { com: { price: "800" } },
      timestamp: "2026-06-04T11:00:00.000Z",
    });

    await GET(makeReq());
    expect(cacheSetRaw).not.toHaveBeenCalled();
  });
});

// ─── Error handling ────────────────────────────────────────────────
describe("Error handling", () => {
  it("RC throw on full-pricing path → 500 with error message echoed for ops", async () => {
    cacheGetRaw.mockResolvedValueOnce(null);
    getDomainPricing.mockRejectedValueOnce(new Error("RC SDK exploded"));

    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("RC SDK exploded");
    expect(body.requestId).toBeTruthy();
    expect(body.responseTime).toMatch(/^\d+ms$/);
  });

  it("RC throw on specific-TLD path → 500", async () => {
    getTLDPricing.mockRejectedValueOnce(new Error("Per-TLD fetch failed"));

    const res = await GET(makeReq("tlds=com"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Per-TLD fetch failed");
  });

  it("non-Error throw → 'Failed to fetch pricing data' fallback message", async () => {
    cacheGetRaw.mockResolvedValueOnce(null);
    getDomainPricing.mockRejectedValueOnce("string-throw");

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch pricing data");
  });
});

// ─── Response shape ────────────────────────────────────────────────
describe("Response shape", () => {
  it("includes requestId + responseTime on every response (success + error)", async () => {
    cacheGetRaw.mockResolvedValueOnce(null);
    getDomainPricing.mockResolvedValueOnce({
      customerPricing: {},
      resellerPricing: {},
    });

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.requestId).toBeTruthy();
    expect(body.responseTime).toMatch(/^\d+ms$/);
  });
});
