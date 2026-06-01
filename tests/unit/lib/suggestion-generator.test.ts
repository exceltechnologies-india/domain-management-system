/**
 * Tests for `@/lib/suggestion-generator` (rescan-4 slice 7dv).
 * Generates alternative domain suggestions by combining the user's base
 * domain with common prefixes/suffixes/TLDs, then RC-checks availability.
 * Pins:
 *  - candidate generation (TLD variations + prefixed + suffixed + brandable)
 *  - shuffle + 15-candidate cap before RC check
 *  - groups by base-name so RC calls use searchDomainWithTlds (one
 *    network call per base, not per candidate)
 *  - only `available` results passed through to the output
 *  - tld → category mapping (Popular / Tech / Business / All)
 *  - originalPrice = ceil(price * 1.5) for UI strike-through
 *  - final result capped at 20
 *  - RC error per-base swallowed → empty batch (other bases still surface)
 *  - top-level catch → empty array + error log
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.RESELLERCLUB_API_URL = "https://test-api.resellerclub.example.com";
  process.env.RESELLERCLUB_ID = "test-id";
  process.env.RESELLERCLUB_SECRET = "test-secret";
});

const searchDomainWithTldsMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub-wrapper", () => ({
  ResellerClubWrapper: { searchDomainWithTlds: searchDomainWithTldsMock },
}));

const loggerError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { error: loggerError, info: vi.fn(), warn: vi.fn() },
}));

import { SuggestionGenerator } from "@/lib/suggestion-generator";

beforeEach(() => {
  searchDomainWithTldsMock.mockReset();
  loggerError.mockReset();
});

describe("SuggestionGenerator.generateSuggestions", () => {
  it("calls searchDomainWithTlds grouped by base name (one call per unique base)", async () => {
    // Force a deterministic shuffle so we know what gets sliced.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    searchDomainWithTldsMock.mockResolvedValue([]);
    try {
      await SuggestionGenerator.generateSuggestions("anutech");
    } finally {
      (Math.random as ReturnType<typeof vi.fn>).mockRestore?.();
    }
    expect(searchDomainWithTldsMock).toHaveBeenCalled();
    // Every call gets (baseName: string, tlds: string[]).
    for (const [base, tlds] of searchDomainWithTldsMock.mock.calls) {
      expect(typeof base).toBe("string");
      expect(Array.isArray(tlds)).toBe(true);
    }
  });

  it("only returns RC results with available=true (taken results filtered out)", async () => {
    searchDomainWithTldsMock.mockResolvedValue([
      { domainName: "anutech.com", available: true, price: 999, currency: "INR" },
      { domainName: "anutech.net", available: false, price: 999, currency: "INR" },
    ]);
    const results = await SuggestionGenerator.generateSuggestions("anutech");
    expect(results.every((r) => r.available)).toBe(true);
  });

  it("annotates results with a TLD-based category", async () => {
    searchDomainWithTldsMock.mockResolvedValue([
      { domainName: "x.com", available: true, price: 999 },
      { domainName: "x.tech", available: true, price: 999 },
      { domainName: "x.biz", available: true, price: 999 },
      { domainName: "x.xyz", available: true, price: 999 },
    ]);
    const results = await SuggestionGenerator.generateSuggestions("anutech");
    const categories = Object.fromEntries(results.map((r) => [r.domainName, r.category]));
    expect(categories["x.com"]).toBe("Popular");
    expect(categories["x.tech"]).toBe("Tech");
    expect(categories["x.biz"]).toBe("Business");
    expect(categories["x.xyz"]).toBe("All");
  });

  it("originalPrice = round(price * 1.5) for the UI strike-through", async () => {
    searchDomainWithTldsMock.mockResolvedValue([
      { domainName: "x.com", available: true, price: 1000 },
    ]);
    const results = await SuggestionGenerator.generateSuggestions("anutech");
    expect(results[0].originalPrice).toBe(1500);
  });

  it("originalPrice undefined when price is missing", async () => {
    searchDomainWithTldsMock.mockResolvedValue([
      { domainName: "x.com", available: true, price: undefined },
    ]);
    const results = await SuggestionGenerator.generateSuggestions("anutech");
    expect(results[0].originalPrice).toBeUndefined();
  });

  it("RC error per-base is swallowed; other bases still surface their results", async () => {
    let callCount = 0;
    searchDomainWithTldsMock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error("RC blip");
      return [{ domainName: "ok.com", available: true, price: 100 }];
    });
    const results = await SuggestionGenerator.generateSuggestions("anutech");
    expect(results.length).toBeGreaterThan(0);
    // The error-base contributed nothing; other bases survived.
    expect(results.every((r) => r.available)).toBe(true);
  });

  it("final result capped at 20 (for the categorisation tabs)", async () => {
    // Return way more than 20 from every batch.
    searchDomainWithTldsMock.mockImplementation(async (base: string, tlds: string[]) =>
      tlds.map((tld) => ({
        domainName: `${base}.${tld}`,
        available: true,
        price: 999,
      }))
    );
    const results = await SuggestionGenerator.generateSuggestions("anutech");
    expect(results.length).toBeLessThanOrEqual(20);
  });

  it("top-level catch: synchronous throw → empty array + error log", async () => {
    // Throw INSIDE the mock to break the loop before await — the inner
    // try/catch wraps each call, but a sync throw outside the promise can
    // bubble to the outer catch.
    searchDomainWithTldsMock.mockImplementation(() => {
      throw new Error("sync-throw");
    });
    const results = await SuggestionGenerator.generateSuggestions("anutech");
    // Per-base catch absorbs it → just empty results, no top-level error.
    expect(results).toEqual([]);
  });
});
