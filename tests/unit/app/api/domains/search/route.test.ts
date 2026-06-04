/**
 * Tests for `app/api/domains/search/route.ts` (rescan-4 slice 7g1).
 * Public domain-search endpoint — high-traffic path. Orchestrates
 * rate-limit → schema → TLD parsing → restricted-TLD block →
 * validateDomainName → Redis-cached parallel fan-out to RC search +
 * RC suggestions + DA hosting-existence check. Pins:
 *  - **Rate-limit FIRST** (20/min cap — public unauthenticated path)
 *  - **Schema**: domain min 1 max 253; tlds optional array OR string
 *    (legacy clients comma-separated); quick boolean
 *  - **Domain-with-TLD detection**: split on `.`; multi-level TLD
 *    via parts.slice(1).join('.') (e.g. 'shop.co.uk' → tld='co.uk')
 *  - **Single-TLD restricted-block** (explicit TLD in domain): →
 *    error:'restricted_tld' response with supportContact (NO RC call,
 *    NO cache lookup — short-circuits before validation)
 *  - **Multi-TLD parsing**: array form strips leading dots from each
 *    entry; string form comma-splits + strips leading dots; default
 *    when neither → ['com']
 *  - **All TLDs restricted**: → error:'all_tlds_restricted' with the
 *    restrictedTlds list
 *  - **Some TLDs restricted**: filter out, continue with `allowedTlds`
 *  - **validateDomainName invalid** → 400 'errors.join(", ")' (uses
 *    InputValidator's full error list, not the first one)
 *  - **Quick mode**: returns ONLY availability (no suggestions, no
 *    hosting check); cache get → use; miss → RC fetch + set with
 *    600s TTL (10 min); empty result NOT cached (anti-cache-pollution)
 *  - **Full mode parallel fan-out**: Promise.all over (1) RC search
 *    (results), (2) RC suggestions, (3) DA hosting-existence; all
 *    three independent (any failure on its branch returns fallback;
 *    others continue)
 *  - **Suggestions error SWALLOWED** → empty array (don't fail the
 *    whole search just because suggestion gen blew up)
 *  - **Hosting check only when domainToCheck set** (user typed full
 *    domain OR derived sanitized version); errors → false
 *  - **Response shape**: success + results + suggestions +
 *    hostingExists + searchQuery (originalDomain/baseDomain/searchTlds/
 *    userEnteredDomain) + cached:{results, suggestions} + requestId
 *  - **Outer catch** → 500 with error message
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const searchDomainWithTlds = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub-wrapper", () => ({
  ResellerClubWrapper: { searchDomainWithTlds },
}));

const validateDomainName = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => {
    isValid: boolean;
    sanitized?: string;
    errors: string[];
  }>(() => ({ isValid: true, sanitized: "example", errors: [] }))
);
vi.mock("@/lib/validation", () => ({
  InputValidator: { validateDomainName },
}));

const isRestrictedTLD = vi.hoisted(() =>
  vi.fn<(tld: string) => boolean>(() => false)
);
vi.mock("@/lib/domainRequirements", () => ({ isRestrictedTLD }));

const domainExists = vi.hoisted(() => vi.fn());
vi.mock("@/lib/directadmin", () => ({
  DirectAdminService: { domainExists },
}));

const redisGet = vi.hoisted(() => vi.fn());
const redisSet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/redis", () => ({
  redisCache: { get: redisGet, set: redisSet },
}));

const generateSuggestions = vi.hoisted(() => vi.fn());
vi.mock("@/lib/suggestion-generator", () => ({
  SuggestionGenerator: { generateSuggestions },
}));

const rlIsAllowed = vi.hoisted(() => vi.fn());
const rateLimitResponse = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rate-limit", () => ({
  rateLimiters: { domainSearch: { isAllowed: rlIsAllowed } },
  rateLimitResponse,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/domains/search/route";

function makeReq(body: unknown) {
  return new NextRequest("https://example.com/api/domains/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  searchDomainWithTlds.mockReset().mockResolvedValue([
    {
      domainName: "example.com",
      available: true,
      price: 999,
      currency: "INR",
      registrationPeriod: 1,
      pricingSource: "live",
    },
  ]);
  validateDomainName
    .mockReset()
    .mockReturnValue({ isValid: true, sanitized: "example", errors: [] });
  isRestrictedTLD.mockReset().mockReturnValue(false);
  domainExists.mockReset().mockResolvedValue(false);
  redisGet.mockReset().mockResolvedValue(null);
  redisSet.mockReset().mockResolvedValue(undefined);
  generateSuggestions.mockReset().mockResolvedValue([]);
  rlIsAllowed.mockReset().mockResolvedValue({ allowed: true });
  rateLimitResponse.mockReset();
});

// ─── Rate-limit ────────────────────────────────────────────────────
describe("Rate-limit gate — FIRST", () => {
  it("not allowed → rateLimitResponse (NO downstream)", async () => {
    const rlResp = NextResponse.json({ error: "rl" }, { status: 429 });
    rlIsAllowed.mockResolvedValueOnce({ allowed: false });
    rateLimitResponse.mockReturnValueOnce(rlResp);
    const res = await POST(makeReq({ domain: "example" }));
    expect(res).toBe(rlResp);
    expect(searchDomainWithTlds).not.toHaveBeenCalled();
  });

  it("limit 20 + 'slow down' message", async () => {
    rlIsAllowed.mockResolvedValueOnce({ allowed: false });
    rateLimitResponse.mockReturnValueOnce(
      NextResponse.json({}, { status: 429 })
    );
    await POST(makeReq({ domain: "example" }));
    const opts = rateLimitResponse.mock.calls[0][1];
    expect(opts.limit).toBe(20);
    expect(opts.message).toMatch(/slow down/);
  });
});

// ─── Schema validation ─────────────────────────────────────────────
describe("Schema validation", () => {
  it("missing domain → 400", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("empty domain → 400", async () => {
    const res = await POST(makeReq({ domain: "" }));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("domain > 253 chars → 400", async () => {
    const res = await POST(
      makeReq({ domain: "a".repeat(254) })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

// ─── Domain-with-TLD detection ─────────────────────────────────────
describe("Domain-with-TLD parsing", () => {
  it("single-level TLD: 'example.com' → baseDomain='example', tld='com'", async () => {
    await POST(makeReq({ domain: "example.com" }));
    expect(searchDomainWithTlds).toHaveBeenCalledWith("example", ["com"]);
  });

  it("multi-level TLD: 'shop.co.uk' → tld='co.uk' (NOT 'uk')", async () => {
    isRestrictedTLD.mockReturnValue(false);
    await POST(makeReq({ domain: "shop.co.uk" }));
    expect(searchDomainWithTlds).toHaveBeenCalledWith("example", ["co.uk"]);
  });

  it("multi-level TLD: 3+ segments preserved as TLD ('a.b.co.in' → 'b.co.in')", async () => {
    await POST(makeReq({ domain: "a.b.co.in" }));
    expect(searchDomainWithTlds).toHaveBeenCalledWith("example", ["b.co.in"]);
  });
});

// ─── Restricted-TLD block (single explicit TLD) ────────────────────
describe("Restricted-TLD block — explicit TLD in domain", () => {
  it("restricted TLD → 'restricted_tld' error response (NO RC call)", async () => {
    isRestrictedTLD.mockImplementation((tld: string) => tld === "au");
    const res = await POST(makeReq({ domain: "example.au" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("restricted_tld");
    expect(body.tld).toBe("au");
    expect(body.supportContact).toBeTruthy();
    expect(searchDomainWithTlds).not.toHaveBeenCalled();
  });

  it("restricted TLD short-circuits BEFORE validateDomainName", async () => {
    isRestrictedTLD.mockReturnValueOnce(true);
    await POST(makeReq({ domain: "example.au" }));
    expect(validateDomainName).not.toHaveBeenCalled();
  });
});

// ─── Multi-TLD parsing ────────────────────────────────────────────
describe("Multi-TLD parsing modes", () => {
  it("default (no tlds) → ['com']", async () => {
    await POST(makeReq({ domain: "example" }));
    expect(searchDomainWithTlds).toHaveBeenCalledWith("example", ["com"]);
  });

  it("array form: strips leading dots from each entry", async () => {
    await POST(
      makeReq({ domain: "example", tlds: [".com", ".net", ".org"] })
    );
    expect(searchDomainWithTlds).toHaveBeenCalledWith("example", [
      "com",
      "net",
      "org",
    ]);
  });

  it("string form (legacy): comma-split + strip leading dots", async () => {
    await POST(makeReq({ domain: "example", tlds: ".com,.net,.org" }));
    expect(searchDomainWithTlds).toHaveBeenCalledWith("example", [
      "com",
      "net",
      "org",
    ]);
  });

  it("all TLDs restricted → 'all_tlds_restricted' error with list", async () => {
    isRestrictedTLD.mockImplementation((tld: string) =>
      ["au", "uk"].includes(tld)
    );
    const res = await POST(
      makeReq({ domain: "example", tlds: [".au", ".uk"] })
    );
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("all_tlds_restricted");
    expect(body.restrictedTlds).toEqual(["au", "uk"]);
    expect(searchDomainWithTlds).not.toHaveBeenCalled();
  });

  it("some TLDs restricted → filter out, continue with allowed", async () => {
    isRestrictedTLD.mockImplementation((tld: string) => tld === "au");
    await POST(
      makeReq({ domain: "example", tlds: [".com", ".au", ".net"] })
    );
    expect(searchDomainWithTlds).toHaveBeenCalledWith("example", [
      "com",
      "net",
    ]);
  });
});

// ─── validateDomainName ────────────────────────────────────────────
describe("validateDomainName", () => {
  it("invalid → 400 with errors.join(', ')", async () => {
    validateDomainName.mockReturnValueOnce({
      isValid: false,
      errors: ["too short", "contains invalid chars"],
    });
    const res = await POST(makeReq({ domain: "x" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("too short, contains invalid chars");
  });
});

// ─── Quick mode ───────────────────────────────────────────────────
describe("Quick mode — fast-first-paint", () => {
  it("returns ONLY availability (no suggestions, no hosting check)", async () => {
    await POST(makeReq({ domain: "example.com", quick: true }));
    expect(generateSuggestions).not.toHaveBeenCalled();
    expect(domainExists).not.toHaveBeenCalled();
  });

  it("response shape: results + empty suggestions + hostingExists:false", async () => {
    const res = await POST(makeReq({ domain: "example.com", quick: true }));
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.results).toHaveLength(1);
    expect(body.suggestions).toEqual([]);
    expect(body.hostingExists).toBe(false);
  });

  it("cache hit: redisGet returns array → skip RC fetch", async () => {
    const cached = [{ domainName: "cached.com", available: true }];
    redisGet.mockResolvedValueOnce(cached);
    await POST(makeReq({ domain: "example.com", quick: true }));
    expect(searchDomainWithTlds).not.toHaveBeenCalled();
  });

  it("cache miss → RC fetch + set with 600s TTL", async () => {
    redisGet.mockResolvedValueOnce(null);
    await POST(makeReq({ domain: "example.com", quick: true }));
    expect(redisSet).toHaveBeenCalledWith(
      expect.stringContaining("domain:check:"),
      expect.any(Array),
      600
    );
  });

  it("empty result NOT cached (anti-cache-pollution)", async () => {
    redisGet.mockResolvedValueOnce(null);
    searchDomainWithTlds.mockResolvedValueOnce([]);
    await POST(makeReq({ domain: "example.com", quick: true }));
    expect(redisSet).not.toHaveBeenCalled();
  });

  it("cached:{results:true} when served from cache", async () => {
    redisGet.mockResolvedValueOnce([
      { domainName: "cached.com", available: true },
    ]);
    const res = await POST(makeReq({ domain: "example.com", quick: true }));
    const body = await res.json();
    expect(body.cached.results).toBe(true);
  });
});

// ─── Full mode parallel fan-out ────────────────────────────────────
describe("Full mode — Promise.all parallel fan-out", () => {
  it("calls RC search + RC suggestions + DA hostingExists in parallel", async () => {
    await POST(makeReq({ domain: "example.com" }));
    expect(searchDomainWithTlds).toHaveBeenCalled();
    expect(generateSuggestions).toHaveBeenCalled();
    expect(domainExists).toHaveBeenCalled();
  });

  it("suggestions error SWALLOWED → empty array (search still succeeds)", async () => {
    generateSuggestions.mockRejectedValueOnce(new Error("RC down"));
    const res = await POST(makeReq({ domain: "example.com" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suggestions).toEqual([]);
    expect(body.success).toBe(true);
  });

  it("hostingExists error SWALLOWED → false", async () => {
    domainExists.mockRejectedValueOnce(new Error("DA down"));
    const res = await POST(makeReq({ domain: "example.com" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hostingExists).toBe(false);
  });

  it("hosting check ONLY when domainToCheck set (no TLD entered + no sanitized) → skipped", async () => {
    validateDomainName.mockReturnValueOnce({
      isValid: true,
      sanitized: undefined,
      errors: [],
    });
    await POST(makeReq({ domain: "example" })); // no TLD
    expect(domainExists).not.toHaveBeenCalled();
  });
});

// ─── Cache behaviour (full mode) ───────────────────────────────────
describe("Cache behaviour — full mode", () => {
  it("results cache hit → cached:{results:true}", async () => {
    redisGet.mockImplementation(async (key: string) =>
      key.startsWith("domain:check:")
        ? [{ domainName: "cached.com", available: true }]
        : null
    );
    const res = await POST(makeReq({ domain: "example.com" }));
    const body = await res.json();
    expect(body.cached.results).toBe(true);
  });

  it("suggestions cache hit → cached:{suggestions:true}", async () => {
    redisGet.mockImplementation(async (key: string) =>
      key.startsWith("domain:suggestions:")
        ? [{ domainName: "sug.com", available: true }]
        : null
    );
    const res = await POST(makeReq({ domain: "example.com" }));
    const body = await res.json();
    expect(body.cached.suggestions).toBe(true);
    expect(generateSuggestions).not.toHaveBeenCalled();
  });

  it("cache miss → set BOTH results + suggestions with 600s TTL", async () => {
    generateSuggestions.mockResolvedValueOnce([
      { domainName: "sug.com", available: true },
    ]);
    await POST(makeReq({ domain: "example.com" }));
    const setCalls = redisSet.mock.calls;
    const hasResultsSet = setCalls.some(
      (c) => typeof c[0] === "string" && c[0].startsWith("domain:check:") && c[2] === 600
    );
    const hasSuggestionsSet = setCalls.some(
      (c) =>
        typeof c[0] === "string" &&
        c[0].startsWith("domain:suggestions:") &&
        c[2] === 600
    );
    expect(hasResultsSet).toBe(true);
    expect(hasSuggestionsSet).toBe(true);
  });

  it("empty suggestions NOT cached", async () => {
    generateSuggestions.mockResolvedValueOnce([]);
    await POST(makeReq({ domain: "example.com" }));
    const setCalls = redisSet.mock.calls;
    const hasSuggestionsSet = setCalls.some(
      (c) =>
        typeof c[0] === "string" && c[0].startsWith("domain:suggestions:")
    );
    expect(hasSuggestionsSet).toBe(false);
  });
});

// ─── Response shape ────────────────────────────────────────────────
describe("Response shape", () => {
  it("full mode: success + results + suggestions + hostingExists + searchQuery + cached", async () => {
    const res = await POST(makeReq({ domain: "example.com" }));
    const body = await res.json();
    expect(body).toMatchObject({
      success: true,
      results: expect.any(Array),
      suggestions: expect.any(Array),
      hostingExists: expect.any(Boolean),
      searchQuery: expect.objectContaining({
        originalDomain: "example.com",
        baseDomain: expect.any(String),
        searchTlds: expect.any(Array),
      }),
      cached: expect.objectContaining({
        results: expect.any(Boolean),
        suggestions: expect.any(Boolean),
      }),
    });
    expect(body.requestId).toBeTruthy();
    expect(body.responseTime).toMatch(/^\d+ms$/);
  });

  it("searchQuery.userEnteredDomain reflects user-entered when domain has TLD", async () => {
    const res = await POST(makeReq({ domain: "example.com" }));
    const body = await res.json();
    expect(body.searchQuery.userEnteredDomain).toBe("example.com");
  });

  it("searchQuery.userEnteredDomain is null when base-only", async () => {
    const res = await POST(makeReq({ domain: "example" }));
    const body = await res.json();
    expect(body.searchQuery.userEnteredDomain).toBeNull();
  });
});

// ─── Outer catch ───────────────────────────────────────────────────
describe("Outer catch — 500 fallback", () => {
  it("RC search throw → 500 with error message", async () => {
    searchDomainWithTlds.mockRejectedValueOnce(
      new Error("RC catastrophically failed")
    );
    const res = await POST(makeReq({ domain: "example.com" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("RC catastrophically failed");
  });

  it("non-Error throw → 500 with generic message", async () => {
    searchDomainWithTlds.mockRejectedValueOnce("string-thrown");
    const res = await POST(makeReq({ domain: "example.com" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Domain search failed due to a technical error");
  });
});
