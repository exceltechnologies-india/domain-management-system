/**
 * Tests for `app/api/admin/tld-pricing/route.ts` (rescan-4 slice 7g5).
 * Admin TLD-pricing dashboard endpoint. Caches the ResellerClub
 * customer/reseller pricing comparison in Redis (shared with the
 * customer-facing /api/domains/pricing path). Pins:
 *  - **Admin auth gate FIRST** (no admin → 401, no DB call)
 *  - **Cache settings**: tld_pricing_cache_enabled DEFAULTS TO TRUE
 *    when absent; tld_pricing_cache_ttl applied via setTTL when present
 *  - **Cache hit happy path**: cachedData returned with
 *    `pricingSource + ' (Cached from Redis)'` suffix + cached:true +
 *    cachedAt ISO; NO RC call
 *  - **Cache-quality auto-purge**: cachedData.totalCount === 0 OR
 *    empty tldPricing → cache purged + fall through to fresh fetch
 *    (anti-stale-empty-cache)
 *  - **PricingService.getDomainPricing called on miss**; raw cache
 *    populated for customer-facing /api/domains/pricing reuse
 *    (customer + reseller + timestamp shape)
 *  - **TLD key conversion**: 'dotXXX' → 'XXX', 'codotXXX' → 'co.XXX'
 *    (multi-level TLD reconstruction); 'privacy-protection' AND
 *    'premium_dns' SKIPPED (service entries); other non-dot/non-codot
 *    keys SKIPPED (obscure internal codes)
 *  - **Price extraction tolerates 4 shapes** per side: string,
 *    object.addnewdomain['1'], object.addnewdomain (string),
 *    object['1'], object.price; NaN coerced to 0
 *  - **Margin calc**: (customer - reseller) / customer * 100; both
 *    must be > 0 (no /0 risk)
 *  - **Only TLDs with customerPrice OR resellerPrice > 0 included**
 *    (zero-priced entries filtered)
 *  - **Sort alphabetically by tld** (`.ai` before `.com`)
 *  - **getTldCategory / getTldDescription** fallback to 'Other' /
 *    'Domain extension' for unknowns
 *  - **Cache write contract**: enabled + tldPricing.length > 0 →
 *    .set(); empty → REFUSES to cache + .purge() (anti-cache-
 *    pollution; empty cache from a transient RC outage would
 *    persist 'no TLDs available' until next miss)
 *  - **Outer catch** → 500 'Failed to fetch TLD pricing'
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const getDomainPricing = vi.hoisted(() => vi.fn());
vi.mock("@/lib/pricing-service", () => ({
  PricingService: { getDomainPricing },
}));

const cacheGet = vi.hoisted(() => vi.fn());
const cacheSet = vi.hoisted(() => vi.fn());
const cacheSetRaw = vi.hoisted(() => vi.fn());
const cachePurge = vi.hoisted(() => vi.fn());
const cacheSetTTL = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tld-pricing-cache", () => ({
  tldPricingCache: {
    get: cacheGet,
    set: cacheSet,
    setRaw: cacheSetRaw,
    purge: cachePurge,
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

vi.mock("@/lib/dateUtils", () => ({
  formatIndianCurrency: (n: number) => `₹${n}`,
  formatIndianNumber: (n: number) => String(n),
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/admin/tld-pricing/route";

function makeReq() {
  return new NextRequest("https://example.com/api/admin/tld-pricing", {
    method: "GET",
  });
}

const admin = { _id: "A1", email: "admin@x.com", role: "admin" };

beforeEach(() => {
  getAdminFromRequest.mockReset().mockResolvedValue(admin);
  connectToDatabase.mockReset().mockResolvedValue(undefined);
  getSettingsMap.mockReset().mockResolvedValue({});
  cacheGet.mockReset().mockResolvedValue(null);
  cacheSet.mockReset().mockResolvedValue(undefined);
  cacheSetRaw.mockReset().mockResolvedValue(undefined);
  cachePurge.mockReset().mockResolvedValue(undefined);
  cacheSetTTL.mockReset();
  getDomainPricing.mockReset();
});

// ─── Auth gate ─────────────────────────────────────────────────────
describe("Admin auth gate FIRST", () => {
  it("no admin → 401 (no DB connect, no cache get, no RC call)", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    expect(connectToDatabase).not.toHaveBeenCalled();
    expect(cacheGet).not.toHaveBeenCalled();
    expect(getDomainPricing).not.toHaveBeenCalled();
  });
});

// ─── Cache settings ────────────────────────────────────────────────
describe("Cache settings", () => {
  it("cache enabled DEFAULTS TO TRUE when settings absent", async () => {
    getSettingsMap.mockResolvedValueOnce({});
    getDomainPricing.mockResolvedValueOnce({});
    await GET(makeReq());
    // cacheGet was called → cache was enabled
    expect(cacheGet).toHaveBeenCalled();
  });

  it("cache disabled (=== false) → cacheGet NOT called, cacheSet NOT called", async () => {
    getSettingsMap.mockResolvedValueOnce({
      tld_pricing_cache_enabled: false,
    });
    getDomainPricing.mockResolvedValueOnce({});
    await GET(makeReq());
    expect(cacheGet).not.toHaveBeenCalled();
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("TTL setting applied via setTTL", async () => {
    getSettingsMap.mockResolvedValueOnce({
      tld_pricing_cache_ttl: "1200",
    });
    getDomainPricing.mockResolvedValueOnce({});
    await GET(makeReq());
    expect(cacheSetTTL).toHaveBeenCalledWith(1200);
  });
});

// ─── Cache hit happy path ──────────────────────────────────────────
describe("Cache hit happy path", () => {
  it("cached data returned with '(Cached from Redis)' suffix + cached:true + cachedAt ISO; NO RC call", async () => {
    const cachedAt = Date.now() - 60000;
    cacheGet.mockResolvedValueOnce({
      tldPricing: [{ tld: ".com", customerPrice: 999, resellerPrice: 800 }],
      totalCount: 1,
      lastUpdated: "2026-06-04T00:00:00Z",
      pricingSource: "ResellerClub API",
      cachedAt,
    });

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.cached).toBe(true);
    expect(body.totalCount).toBe(1);
    expect(body.pricingSource).toMatch(/Cached from Redis/);
    expect(body.cachedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(getDomainPricing).not.toHaveBeenCalled();
  });
});

// ─── Cache auto-purge (anti-stale-empty) ───────────────────────────
describe("Cache auto-purge on empty data", () => {
  it("cachedData.totalCount === 0 → purge + fall through to fresh fetch", async () => {
    cacheGet.mockResolvedValueOnce({
      tldPricing: [],
      totalCount: 0,
      lastUpdated: "2026-06-04T00:00:00Z",
      pricingSource: "ResellerClub API",
      cachedAt: Date.now(),
    });
    getDomainPricing.mockResolvedValueOnce({});

    await GET(makeReq());
    expect(cachePurge).toHaveBeenCalled();
    expect(getDomainPricing).toHaveBeenCalled();
  });

  it("cachedData with empty tldPricing array → purge + fresh fetch", async () => {
    cacheGet.mockResolvedValueOnce({
      tldPricing: [],
      totalCount: 5, // mismatched but tldPricing empty
      lastUpdated: "X",
      pricingSource: "X",
      cachedAt: Date.now(),
    });
    getDomainPricing.mockResolvedValueOnce({});

    await GET(makeReq());
    expect(cachePurge).toHaveBeenCalled();
    expect(getDomainPricing).toHaveBeenCalled();
  });

  it("cachedData with missing tldPricing field → purge", async () => {
    cacheGet.mockResolvedValueOnce({
      totalCount: 0,
      lastUpdated: "X",
      pricingSource: "X",
      cachedAt: Date.now(),
    } as any);
    getDomainPricing.mockResolvedValueOnce({});
    await GET(makeReq());
    expect(cachePurge).toHaveBeenCalled();
  });
});

// ─── Raw cache populated for /api/domains/pricing reuse ────────────
describe("Raw cache (shared with customer endpoint)", () => {
  it("setRaw called with customer + reseller + timestamp shape on miss", async () => {
    cacheGet.mockResolvedValueOnce(null);
    getDomainPricing.mockResolvedValueOnce({
      customerPricing: { dotcom: { addnewdomain: { "1": "999" } } },
      resellerPricing: { dotcom: { addnewdomain: { "1": "800" } } },
      timestamp: "2026-06-04T12:00:00Z",
    });

    await GET(makeReq());
    expect(cacheSetRaw).toHaveBeenCalledWith({
      customerPricing: expect.any(Object),
      resellerPricing: expect.any(Object),
      timestamp: "2026-06-04T12:00:00Z",
    });
  });

  it("setRaw skipped when caching disabled", async () => {
    getSettingsMap.mockResolvedValueOnce({
      tld_pricing_cache_enabled: false,
    });
    getDomainPricing.mockResolvedValueOnce({
      customerPricing: {},
      resellerPricing: {},
    });
    await GET(makeReq());
    expect(cacheSetRaw).not.toHaveBeenCalled();
  });
});

// ─── TLD key conversion ────────────────────────────────────────────
describe("TLD key conversion (dotXXX / codotXXX → readable)", () => {
  async function pricingFor(key: string, customerPrice = "999") {
    cacheGet.mockResolvedValueOnce(null);
    getDomainPricing.mockResolvedValueOnce({
      customerPricing: { [key]: { addnewdomain: { "1": customerPrice } } },
      resellerPricing: { [key]: { addnewdomain: { "1": "800" } } },
    });
    const res = await GET(makeReq());
    const body = await res.json();
    return body.tldPricing as Array<{ tld: string }>;
  }

  it("'dotcom' → '.com'", async () => {
    const r = await pricingFor("dotcom");
    expect(r[0]?.tld).toBe(".com");
  });

  it("'dotio' → '.io'", async () => {
    const r = await pricingFor("dotio");
    expect(r[0]?.tld).toBe(".io");
  });

  it("'codotuk' → '.co.uk' (multi-level reconstruction)", async () => {
    const r = await pricingFor("codotuk");
    expect(r[0]?.tld).toBe(".co.uk");
  });

  it("'codotin' → '.co.in'", async () => {
    const r = await pricingFor("codotin");
    expect(r[0]?.tld).toBe(".co.in");
  });

  it("'privacy-protection' SKIPPED (service entry)", async () => {
    const r = await pricingFor("privacy-protection");
    expect(r).toEqual([]);
  });

  it("'premium_dns' SKIPPED (service entry)", async () => {
    const r = await pricingFor("premium_dns");
    expect(r).toEqual([]);
  });

  it("non-dot non-codot key SKIPPED (obscure internal)", async () => {
    const r = await pricingFor("randomkey");
    expect(r).toEqual([]);
  });
});

// ─── Price extraction shapes ───────────────────────────────────────
describe("Price extraction (tolerates multiple shapes)", () => {
  async function fetchPrice(
    customer: unknown,
    reseller: unknown
  ): Promise<{ customerPrice: number; resellerPrice: number } | undefined> {
    cacheGet.mockResolvedValueOnce(null);
    getDomainPricing.mockResolvedValueOnce({
      customerPricing: { dotcom: customer },
      resellerPricing: { dotcom: reseller },
    });
    const res = await GET(makeReq());
    const body = await res.json();
    return body.tldPricing[0];
  }

  it("nested addnewdomain.1 (canonical RC shape)", async () => {
    const p = await fetchPrice(
      { addnewdomain: { "1": "999" } },
      { addnewdomain: { "1": "800" } }
    );
    expect(p?.customerPrice).toBe(999);
    expect(p?.resellerPrice).toBe(800);
  });

  it("top-level '1' fallback (no addnewdomain wrapper)", async () => {
    const p = await fetchPrice(
      { "1": "999" },
      { "1": "800" }
    );
    expect(p?.customerPrice).toBe(999);
    expect(p?.resellerPrice).toBe(800);
  });

  it("'.price' field fallback", async () => {
    const p = await fetchPrice(
      { price: "999" },
      { price: "800" }
    );
    expect(p?.customerPrice).toBe(999);
    expect(p?.resellerPrice).toBe(800);
  });

  it("string value (top-level)", async () => {
    const p = await fetchPrice("999", "800");
    expect(p?.customerPrice).toBe(999);
    expect(p?.resellerPrice).toBe(800);
  });

  it("reseller nested.0.pricing shape (legacy)", async () => {
    const p = await fetchPrice(
      { addnewdomain: { "1": "999" } },
      { "0": { pricing: { addnewdomain: { "1": "750" } } } }
    );
    expect(p?.customerPrice).toBe(999);
    expect(p?.resellerPrice).toBe(750);
  });

  it("NaN-producing input → coerced to 0", async () => {
    const p = await fetchPrice(
      { addnewdomain: { "1": "not-a-number" } },
      { addnewdomain: { "1": "800" } }
    );
    expect(p?.customerPrice).toBe(0);
    expect(p?.resellerPrice).toBe(800);
  });

  it("both prices 0 → TLD SKIPPED (no entry in response)", async () => {
    cacheGet.mockResolvedValueOnce(null);
    getDomainPricing.mockResolvedValueOnce({
      customerPricing: { dotcom: "0" },
      resellerPricing: { dotcom: "0" },
    });
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.tldPricing).toEqual([]);
  });
});

// ─── Margin calculation ────────────────────────────────────────────
describe("Margin calculation", () => {
  it("(customer - reseller) / customer * 100", async () => {
    cacheGet.mockResolvedValueOnce(null);
    getDomainPricing.mockResolvedValueOnce({
      customerPricing: { dotcom: { addnewdomain: { "1": "1000" } } },
      resellerPricing: { dotcom: { addnewdomain: { "1": "800" } } },
    });
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.tldPricing[0].margin).toBe(20); // (1000-800)/1000 * 100
  });

  it("only one side has price → margin 0 (no /0 risk)", async () => {
    cacheGet.mockResolvedValueOnce(null);
    getDomainPricing.mockResolvedValueOnce({
      customerPricing: { dotcom: { addnewdomain: { "1": "999" } } },
      resellerPricing: { dotcom: { addnewdomain: { "1": "0" } } },
    });
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.tldPricing[0].margin).toBe(0);
  });
});

// ─── Sort + category/description ───────────────────────────────────
describe("Output sort + category + description", () => {
  it("sorted alphabetically by tld ('.ai' before '.com')", async () => {
    cacheGet.mockResolvedValueOnce(null);
    getDomainPricing.mockResolvedValueOnce({
      customerPricing: {
        dotcom: { addnewdomain: { "1": "999" } },
        dotai: { addnewdomain: { "1": "5000" } },
      },
      resellerPricing: {
        dotcom: { addnewdomain: { "1": "800" } },
        dotai: { addnewdomain: { "1": "4000" } },
      },
    });
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.tldPricing.map((t: { tld: string }) => t.tld)).toEqual([
      ".ai",
      ".com",
    ]);
  });

  it("known TLD → category set ('com' → 'Generic', 'shop' → 'New Generic', 'in' → 'Country Code')", async () => {
    cacheGet.mockResolvedValueOnce(null);
    getDomainPricing.mockResolvedValueOnce({
      customerPricing: {
        dotcom: { addnewdomain: { "1": "999" } },
        dotshop: { addnewdomain: { "1": "1500" } },
        dotin: { addnewdomain: { "1": "500" } },
      },
      resellerPricing: {
        dotcom: { addnewdomain: { "1": "800" } },
        dotshop: { addnewdomain: { "1": "1200" } },
        dotin: { addnewdomain: { "1": "400" } },
      },
    });
    const res = await GET(makeReq());
    const body = await res.json();
    const byTld = (t: string) =>
      body.tldPricing.find((x: { tld: string }) => x.tld === t);
    expect(byTld(".com").category).toBe("Generic");
    expect(byTld(".shop").category).toBe("New Generic");
    expect(byTld(".in").category).toBe("Country Code");
  });

  it("unknown TLD → category 'Other' + description 'Domain extension'", async () => {
    cacheGet.mockResolvedValueOnce(null);
    getDomainPricing.mockResolvedValueOnce({
      customerPricing: { dotrandomxyz: { addnewdomain: { "1": "999" } } },
      resellerPricing: { dotrandomxyz: { addnewdomain: { "1": "800" } } },
    });
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.tldPricing[0].category).toBe("Other");
    expect(body.tldPricing[0].description).toBe("Domain extension");
  });
});

// ─── Cache write contract ──────────────────────────────────────────
describe("Cache write contract", () => {
  it("non-empty data + cache enabled → .set() called with shape", async () => {
    cacheGet.mockResolvedValueOnce(null);
    getDomainPricing.mockResolvedValueOnce({
      customerPricing: { dotcom: { addnewdomain: { "1": "999" } } },
      resellerPricing: { dotcom: { addnewdomain: { "1": "800" } } },
    });

    await GET(makeReq());

    expect(cacheSet).toHaveBeenCalledWith({
      tldPricing: expect.any(Array),
      totalCount: 1,
      lastUpdated: expect.any(String),
      pricingSource: expect.any(String),
    });
  });

  it("empty result + cache enabled → REFUSES to cache + purges (anti-cache-pollution)", async () => {
    cacheGet.mockResolvedValueOnce(null);
    getDomainPricing.mockResolvedValueOnce({
      customerPricing: {},
      resellerPricing: {},
    });

    await GET(makeReq());

    expect(cacheSet).not.toHaveBeenCalled();
    expect(cachePurge).toHaveBeenCalled();
  });
});

// ─── Response shape ────────────────────────────────────────────────
describe("Response shape on miss", () => {
  it("success + tldPricing + totalCount + lastUpdated + pricingSource + cached:false", async () => {
    cacheGet.mockResolvedValueOnce(null);
    getDomainPricing.mockResolvedValueOnce({});

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body).toMatchObject({
      success: true,
      tldPricing: expect.any(Array),
      totalCount: expect.any(Number),
      lastUpdated: expect.any(String),
      pricingSource: "ResellerClub API (Indian Pricing)",
      cached: false,
    });
  });
});

// ─── Outer catch ───────────────────────────────────────────────────
describe("Outer catch", () => {
  it("connectToDatabase throw → 500 'Failed to fetch TLD pricing'", async () => {
    connectToDatabase.mockRejectedValueOnce(new Error("DB down"));
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch TLD pricing");
  });

  it("PricingService throw → 500", async () => {
    cacheGet.mockResolvedValueOnce(null);
    getDomainPricing.mockRejectedValueOnce(new Error("RC down"));
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
  });
});
