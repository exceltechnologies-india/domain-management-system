/**
 * Tests for `app/api/domains/bulk-search/route.ts` (slice 7ht, part 2).
 *
 * Public bulk domain-availability search (5/IP rate-limited). The
 * "check 20 domains at once" CTA on the cross-sell / suggestion UX.
 *
 * Threat model:
 *  - **Rate-limit-bypass via huge body**: rate-limit must run BEFORE
 *    body parse so an attacker can't send a 100k-domain body to
 *    exhaust the parser before the throttle kicks in. Pinned.
 *  - **Anti-DoS hard cap on actual lookups**: even with a 60-item
 *    payload (zod ceiling), only the first 20 deduped entries are
 *    actually queried at the registrar. Pinned with a 30-entry probe.
 *  - **Per-domain failure cascade**: a single restricted-TLD or RC
 *    error must NOT blank the rest of the results. Pinned via
 *    Promise.allSettled isolation.
 *
 * Other pins:
 *  - Zod: domains array 1..60 items, each ≤253 chars
 *  - Sanitize: trim + lowercase + must contain "." + dedupe via Set
 *  - All-empty after sanitize → 400 "must include a TLD"
 *  - isRestrictedTLD short-circuits: result has restricted:true and
 *    available:false; no RC call for that domain
 *  - searchDomain match by lowercase first; fallback to results[0];
 *    no match at all → result.error="No result returned"
 *  - RC throw on one domain → that result.error="Availability check
 *    failed" but other domains complete
 *  - Outer catch → 500 generic
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const isAllowed = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit")>(
    "@/lib/rate-limit"
  );
  return {
    ...actual,
    rateLimiters: { bulkDomainSearch: { isAllowed } },
  };
});

const searchDomain = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub", () => ({
  ResellerClubAPI: { searchDomain },
}));

const isRestrictedTLD = vi.hoisted(() => vi.fn());
vi.mock("@/lib/domainRequirements", () => ({ isRestrictedTLD }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/domains/bulk-search/route";

function makeReq(body: unknown) {
  return new NextRequest("https://example.com/api/domains/bulk-search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function mockMatch(domainName: string, available: boolean) {
  return {
    domainName,
    available,
    price: 999,
    currency: "INR",
    registrationPeriod: 1,
    pricingSource: "live",
  };
}

beforeEach(() => {
  isAllowed.mockReset().mockResolvedValue({ allowed: true, remaining: 5 });
  searchDomain.mockReset();
  isRestrictedTLD.mockReset().mockReturnValue(false);
});

describe("Rate-limit BEFORE body parse (anti-probe)", () => {
  it("rate-limit denied → 429; body NEVER parsed; RC NEVER called", async () => {
    isAllowed.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });
    // Hostile body — if rate-limit ran after parse, this would 400.
    const res = await POST(makeReq("{not-json"));
    expect(res.status).toBe(429);
    expect(searchDomain).not.toHaveBeenCalled();
  });
});

describe("Zod schema", () => {
  it("empty array → 400 (min:1)", async () => {
    const res = await POST(makeReq({ domains: [] }));
    expect(res.status).toBe(400);
    expect(searchDomain).not.toHaveBeenCalled();
  });

  it("> 60 entries → 400 (max:MAX_DOMAINS*3)", async () => {
    const res = await POST(
      makeReq({ domains: Array(61).fill("a.com") })
    );
    expect(res.status).toBe(400);
  });

  it("entry > 253 chars → 400", async () => {
    const res = await POST(makeReq({ domains: ["x".repeat(254) + ".com"] }));
    expect(res.status).toBe(400);
  });
});

describe("Sanitize + dedupe + 20-item cap", () => {
  it("trim + lower-case + dedupe applied before lookup", async () => {
    searchDomain.mockResolvedValue([mockMatch("example.com", true)]);
    await POST(
      makeReq({
        domains: [
          "  EXAMPLE.COM ",
          "example.com",
          "Example.COM",
          "OTHER.com",
        ],
      })
    );
    // Should only have called for 2 unique domains
    expect(searchDomain).toHaveBeenCalledTimes(2);
    const calls = searchDomain.mock.calls.map((c) => c[0]);
    expect(calls.sort()).toEqual(["example.com", "other.com"]);
  });

  it("entries without a '.' are filtered out", async () => {
    searchDomain.mockResolvedValue([mockMatch("example.com", true)]);
    await POST(
      makeReq({ domains: ["example.com", "no-tld-here", "good.org"] })
    );
    expect(searchDomain).toHaveBeenCalledTimes(2);
    const calls = searchDomain.mock.calls.map((c) => c[0]);
    expect(calls.sort()).toEqual(["example.com", "good.org"]);
  });

  it("all entries lacked a TLD → 400 'must include a TLD'", async () => {
    const res = await POST(
      makeReq({ domains: ["nodots", "another-no-tld"] })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.toLowerCase()).toContain("tld");
    expect(searchDomain).not.toHaveBeenCalled();
  });

  it("CAP=20: payload of 30 unique → only 20 actually queried", async () => {
    searchDomain.mockResolvedValue([mockMatch("x.com", true)]);
    const thirty = Array.from({ length: 30 }, (_, i) => `d${i}.com`);
    await POST(makeReq({ domains: thirty }));
    expect(searchDomain).toHaveBeenCalledTimes(20);
  });
});

describe("Restricted-TLD short-circuit", () => {
  it("restricted TLD → result has restricted:true + available:false; RC NOT called for that one", async () => {
    isRestrictedTLD.mockImplementation((tld: string) => tld === ".gov.in");
    searchDomain.mockResolvedValue([mockMatch("ok.com", true)]);

    const res = await POST(
      makeReq({ domains: ["bad.gov.in", "ok.com"] })
    );
    const body = await res.json();
    const bad = body.results.find(
      (r: { domainName: string }) => r.domainName === "bad.gov.in"
    );
    expect(bad).toEqual(
      expect.objectContaining({
        domainName: "bad.gov.in",
        available: false,
        restricted: true,
      })
    );
    // RC searchDomain should ONLY have been called for ok.com
    expect(searchDomain).toHaveBeenCalledTimes(1);
    expect(searchDomain).toHaveBeenCalledWith("ok.com");
  });
});

describe("searchDomain match selection", () => {
  it("prefers exact lowercase match over arbitrary results[0]", async () => {
    searchDomain.mockResolvedValueOnce([
      mockMatch("other.com", false),
      mockMatch("example.com", true),
    ]);
    const res = await POST(makeReq({ domains: ["example.com"] }));
    const body = await res.json();
    expect(body.results[0]).toEqual(
      expect.objectContaining({
        domainName: "example.com",
        available: true,
      })
    );
  });

  it("falls back to results[0] when no exact-lowercase match", async () => {
    searchDomain.mockResolvedValueOnce([
      mockMatch("similar.com", false),
      mockMatch("another.com", true),
    ]);
    const res = await POST(makeReq({ domains: ["example.com"] }));
    const body = await res.json();
    // Returned results[0] = similar.com
    expect(body.results[0].domainName).toBe("similar.com");
  });

  it("empty results → result.error='No result returned'", async () => {
    searchDomain.mockResolvedValueOnce([]);
    const res = await POST(makeReq({ domains: ["example.com"] }));
    const body = await res.json();
    expect(body.results[0]).toEqual(
      expect.objectContaining({
        domainName: "example.com",
        available: false,
        error: "No result returned",
      })
    );
  });
});

describe("Per-domain failure isolation (Promise.allSettled)", () => {
  it("RC throws for one domain → other domains still complete; that one carries error='Availability check failed'", async () => {
    searchDomain.mockImplementation(async (domain: string) => {
      if (domain === "a.com") throw new Error("RC timeout");
      return [mockMatch(domain, true)];
    });

    const res = await POST(makeReq({ domains: ["a.com", "b.com"] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const a = body.results.find(
      (r: { domainName: string }) => r.domainName === "a.com"
    );
    const b = body.results.find(
      (r: { domainName: string }) => r.domainName === "b.com"
    );
    expect(a.error).toBe("Availability check failed");
    expect(a.available).toBe(false);
    expect(b.available).toBe(true);
  });
});

describe("Outer catch", () => {
  it("rate-limit helper throw → 500 generic", async () => {
    isAllowed.mockRejectedValueOnce(new Error("rate-limit-store down"));
    const res = await POST(makeReq({ domains: ["a.com"] }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("Internal server error");
  });
});
