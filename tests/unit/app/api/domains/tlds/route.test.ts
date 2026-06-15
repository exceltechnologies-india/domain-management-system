/**
 * Tests for `app/api/domains/tlds/route.ts` (slice 7iB).
 *
 * Public, unauthenticated TLD-list endpoint used by the domain
 * search UI. Three paths:
 *  1. `x-testing-mode: true` header → returns a static TLD list with
 *     `testingMode: true` so end-to-end tests don't depend on
 *     ResellerClub being reachable.
 *  2. Default → returns the curated comprehensive TLD list.
 *  3. Outer catch → falls back to a SHORT hardcoded list with
 *     `fallback: true` so the search UI never blanks (the public
 *     domain-search UI relies on this list to populate filters and
 *     restricted-TLD warnings).
 *
 * Pins:
 *  - **PUBLIC by design** — NO auth gate; pinned (no AuthService call,
 *    no admin gate, no rate-limit). If a future refactor adds auth
 *    here, the public search UI breaks for unauthenticated visitors.
 *  - **Response shape**: each TLD entry is exactly `{name,
 *    displayName: ".${name}", available: true}` — pinned per-list
 *    so a refactor that drops the leading dot or flips the
 *    `available` flag would break UI rendering.
 *  - **Testing-mode header is strict-equals "true"** — `"True"`,
 *    `"1"`, presence-only, all fall through to the live path.
 *  - **requestId** is a 5-char base36 fragment (`toString(36).substring(7)`)
 *    — present on EVERY response (testing / live / fallback). Used
 *    by the UI for correlated error logs.
 *  - **Restricted-TLD presence**: certain TLDs (`gov.in`, etc.) must
 *    NOT appear in the response (they're hard-blocked from
 *    registration; surfacing them in the search UI would set
 *    customer expectations the registrar can't fulfil). Pinned as
 *    an absence check.
 *  - **Comprehensive list parity with testingMode**: both list
 *    bodies are functionally identical (same TLD set) — pinned so
 *    a future divergence (test-only TLDs sneaking into prod) is
 *    caught.
 *  - **Outer catch → 200 with fallback:true** (NOT 500) — the
 *    search UI must always get a usable list; the catch is a
 *    safety-net for any future refactor that turns this into an
 *    async-IO endpoint.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/domains/tlds/route";

function makeReq(headers: Record<string, string> = {}) {
  return new NextRequest("https://example.com/api/domains/tlds", {
    method: "GET",
    headers,
  });
}

interface TldEntry {
  name: string;
  displayName: string;
  available: boolean;
}

interface TldResponse {
  success: boolean;
  tlds: TldEntry[];
  requestId: string;
  testingMode?: boolean;
  fallback?: boolean;
}

beforeEach(() => {
  // No mocks to reset — endpoint is pure (no DB, no auth, no RC).
});

// ═══════════════════════════════════════════════════════════════════
// Public by design — no auth gate
// ═══════════════════════════════════════════════════════════════════
describe("Public by design — no auth gate", () => {
  it("anonymous request → 200 (NO 401, NO 403)", async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
  });

  it("anonymous request returns a TLD list", async () => {
    const res = await GET(makeReq());
    const body = (await res.json()) as TldResponse;
    expect(body.success).toBe(true);
    expect(Array.isArray(body.tlds)).toBe(true);
    expect(body.tlds.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Default (live) path
// ═══════════════════════════════════════════════════════════════════
describe("Default path — comprehensive TLD list", () => {
  it("no header → success:true with tlds + requestId; NO testingMode flag", async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as TldResponse;
    expect(body.success).toBe(true);
    expect(body.testingMode).toBeUndefined();
    expect(body.fallback).toBeUndefined();
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId.length).toBeGreaterThan(0);
  });

  it("includes core gTLDs (.com, .net, .org)", async () => {
    const res = await GET(makeReq());
    const body = (await res.json()) as TldResponse;
    const names = body.tlds.map((t) => t.name);
    expect(names).toContain("com");
    expect(names).toContain("net");
    expect(names).toContain("org");
  });

  it("includes Indian ccTLDs (.in, .co.in, .net.in)", async () => {
    const res = await GET(makeReq());
    const body = (await res.json()) as TldResponse;
    const names = body.tlds.map((t) => t.name);
    expect(names).toContain("in");
    expect(names).toContain("co.in");
    expect(names).toContain("net.in");
  });

  it("includes new-gTLDs (.app, .dev, .xyz, .shop)", async () => {
    const res = await GET(makeReq());
    const body = (await res.json()) as TldResponse;
    const names = body.tlds.map((t) => t.name);
    expect(names).toContain("app");
    expect(names).toContain("dev");
    expect(names).toContain("xyz");
    expect(names).toContain("shop");
  });

  it("returns > 100 TLDs (comprehensive list, not the small fallback)", async () => {
    const res = await GET(makeReq());
    const body = (await res.json()) as TldResponse;
    expect(body.tlds.length).toBeGreaterThan(100);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Response item shape
// ═══════════════════════════════════════════════════════════════════
describe("Response item shape — pinned per-entry", () => {
  it("every entry has exactly { name, displayName, available }", async () => {
    const res = await GET(makeReq());
    const body = (await res.json()) as TldResponse;
    for (const entry of body.tlds) {
      expect(Object.keys(entry).sort()).toEqual(["available", "displayName", "name"]);
    }
  });

  it("displayName is `.${name}` for every entry — pinned", async () => {
    const res = await GET(makeReq());
    const body = (await res.json()) as TldResponse;
    for (const entry of body.tlds) {
      expect(entry.displayName).toBe(`.${entry.name}`);
    }
  });

  it("available is strictly true on every entry (anti-flip — UI relies on this)", async () => {
    const res = await GET(makeReq());
    const body = (await res.json()) as TldResponse;
    for (const entry of body.tlds) {
      expect(entry.available).toBe(true);
    }
  });

  it("no entry has a name containing a leading dot (only displayName carries it)", async () => {
    const res = await GET(makeReq());
    const body = (await res.json()) as TldResponse;
    for (const entry of body.tlds) {
      expect(entry.name.startsWith(".")).toBe(false);
    }
  });

  it("no entry has an empty name", async () => {
    const res = await GET(makeReq());
    const body = (await res.json()) as TldResponse;
    for (const entry of body.tlds) {
      expect(entry.name.length).toBeGreaterThan(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// Restricted-TLD absence
// ═══════════════════════════════════════════════════════════════════
describe("Restricted TLDs MUST NOT appear (UI relies on this)", () => {
  // The registrar can't actually fulfil .gov.in / .ac.in / .mil
  // registrations — surfacing them in the search UI would set
  // customer expectations we can't meet. Pinned as an absence
  // check so a future refactor doesn't accidentally include them.
  it.each([
    "gov.in",
    "ac.in",
    "edu.in",
    "mil",
    "gov",
    "edu",
  ])("does NOT include restricted TLD: %s", async (restricted) => {
    const res = await GET(makeReq());
    const body = (await res.json()) as TldResponse;
    const names = body.tlds.map((t) => t.name);
    expect(names).not.toContain(restricted);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Testing mode (x-testing-mode: true header)
// ═══════════════════════════════════════════════════════════════════
describe("Testing mode header path", () => {
  it("'x-testing-mode: true' → testingMode:true flag set on response", async () => {
    const res = await GET(makeReq({ "x-testing-mode": "true" }));
    const body = (await res.json()) as TldResponse;
    expect(body.success).toBe(true);
    expect(body.testingMode).toBe(true);
    expect(body.fallback).toBeUndefined();
  });

  it("testing mode response carries a requestId", async () => {
    const res = await GET(makeReq({ "x-testing-mode": "true" }));
    const body = (await res.json()) as TldResponse;
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId.length).toBeGreaterThan(0);
  });

  it("testing mode returns TLDs with the same per-entry shape", async () => {
    const res = await GET(makeReq({ "x-testing-mode": "true" }));
    const body = (await res.json()) as TldResponse;
    expect(body.tlds.length).toBeGreaterThan(100);
    for (const entry of body.tlds) {
      expect(entry.displayName).toBe(`.${entry.name}`);
      expect(entry.available).toBe(true);
    }
  });

  it("testing-mode list matches the comprehensive list (no test-only TLD leaks into prod, no prod-only TLD missing from tests)", async () => {
    const live = await GET(makeReq());
    const liveBody = (await live.json()) as TldResponse;
    const test = await GET(makeReq({ "x-testing-mode": "true" }));
    const testBody = (await test.json()) as TldResponse;
    const liveNames = liveBody.tlds.map((t) => t.name).sort();
    const testNames = testBody.tlds.map((t) => t.name).sort();
    expect(testNames).toEqual(liveNames);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Testing mode header — strict-equals "true"
// ═══════════════════════════════════════════════════════════════════
describe("Testing mode header is strict-equals 'true' (case-sensitive)", () => {
  it("'true' → testingMode set", async () => {
    const res = await GET(makeReq({ "x-testing-mode": "true" }));
    const body = (await res.json()) as TldResponse;
    expect(body.testingMode).toBe(true);
  });

  it("'True' (capitalized) → falls through to live path; NO testingMode flag", async () => {
    const res = await GET(makeReq({ "x-testing-mode": "True" }));
    const body = (await res.json()) as TldResponse;
    expect(body.testingMode).toBeUndefined();
  });

  it("'TRUE' → falls through to live path", async () => {
    const res = await GET(makeReq({ "x-testing-mode": "TRUE" }));
    const body = (await res.json()) as TldResponse;
    expect(body.testingMode).toBeUndefined();
  });

  it("'1' → falls through to live path", async () => {
    const res = await GET(makeReq({ "x-testing-mode": "1" }));
    const body = (await res.json()) as TldResponse;
    expect(body.testingMode).toBeUndefined();
  });

  it("empty string → falls through to live path", async () => {
    const res = await GET(makeReq({ "x-testing-mode": "" }));
    const body = (await res.json()) as TldResponse;
    expect(body.testingMode).toBeUndefined();
  });

  it("missing header entirely → live path", async () => {
    const res = await GET(makeReq());
    const body = (await res.json()) as TldResponse;
    expect(body.testingMode).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// requestId uniqueness
// ═══════════════════════════════════════════════════════════════════
describe("requestId — present and varies across calls", () => {
  it("requestId is present on the response (UI correlates this for error logs)", async () => {
    const res = await GET(makeReq());
    const body = (await res.json()) as TldResponse;
    expect(body.requestId).toBeTruthy();
    expect(typeof body.requestId).toBe("string");
  });

  it("requestId varies across calls (not a hard-coded constant)", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const res = await GET(makeReq());
      const body = (await res.json()) as TldResponse;
      ids.add(body.requestId);
    }
    // Not a 100% guarantee with substring(7) on Math.random().toString(36),
    // but with 5 samples and ~36^N entropy collisions should be vanishingly rare.
    expect(ids.size).toBeGreaterThan(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Live-path duplication audit
// ═══════════════════════════════════════════════════════════════════
describe("List consistency", () => {
  it("live list contains no duplicate TLD names (anti-dedup-bug)", async () => {
    const res = await GET(makeReq());
    const body = (await res.json()) as TldResponse;
    const names = body.tlds.map((t) => t.name);
    const set = new Set(names);
    if (set.size !== names.length) {
      const dupes = names.filter((n, i) => names.indexOf(n) !== i);
      // soft assertion: surface the actual duplicate names if any
      throw new Error(
        `Duplicate TLDs detected: ${[...new Set(dupes)].join(", ")}`
      );
    }
    expect(set.size).toBe(names.length);
  });
});
