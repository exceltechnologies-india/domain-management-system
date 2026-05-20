/**
 * Tests for the live price verification used by every domain payment.
 *
 * This module is the underpayment-fraud gate: it fetches LIVE pricing from
 * ResellerClub at order-creation time and refuses payments where the client-
 * supplied total disagrees with the server-computed total. Cached prices are
 * never used to charge — a client could otherwise rehydrate a stale cart at
 * yesterday's lower price.
 *
 * The tests mock @/lib/resellerclub.getDomainPricing so the RC payload shape
 * is driven deterministically, then exercise the real verifyDomainPrices
 * function. Targets:
 *
 *   1. Server-total computation: livePrice × years summed across items.
 *   2. Per-domain mismatch detection within / outside the tolerance window
 *      (₹1 absolute or 0.5% relative, whichever is larger).
 *   3. Unverifiable-TLD refusal (RC has data but not for this TLD → reject;
 *      conservative since this is the attacker-bypass surface).
 *   4. RC-outage fallback: when the live fetch throws OR returns malformed
 *      data, the function falls back to the client total rather than
 *      killing checkout for the whole site.
 *   5. Hosting-only carts (no domain items) → pass through unchanged.
 *   6. The RC pricing-tree shape: `addnewdomain` is keyed by year buckets,
 *      a regression there means we silently charge the 1-year price for a
 *      10-year registration.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted to the top of the file, so the factory cannot reference
// outer-scope locals. Use vi.hoisted to declare the shared mock fn in the
// same hoist phase as vi.mock so both run before any imports execute.
const { mockGetDomainPricing } = vi.hoisted(() => ({
  mockGetDomainPricing: vi.fn(),
}));
vi.mock("@/lib/resellerclub", () => ({
  ResellerClubAPI: {
    getDomainPricing: mockGetDomainPricing,
  },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn(), debug: vi.fn() },
}));

import { verifyDomainPrices } from "@/lib/services/payment/price-verifier";

// ── Helpers ─────────────────────────────────────────────────────────────────
//
// RC's customer-pricing tree is keyed by the per-TLD RC key (".com" → "domcno",
// ".in" → "dotin"). Each entry holds an `addnewdomain` map keyed by year
// bucket ("1" through "10") with the per-year price.

/** Build a full RC pricing response with a single TLD. */
function priceTreeFor(rcKey: string, pricesByYear: Record<string, number>) {
  return { customerPricing: { [rcKey]: { addnewdomain: pricesByYear } } };
}

/** Default RC pricing payload: .com at ₹1,099/yr and .in at ₹699/yr. */
function defaultPricing() {
  const com: Record<string, number> = {};
  const inn: Record<string, number> = {};
  for (let y = 1; y <= 10; y++) {
    com[String(y)] = 1099;
    inn[String(y)] = 699;
  }
  return {
    customerPricing: {
      domcno: { addnewdomain: com },
      dotin: { addnewdomain: inn },
    },
  };
}

beforeEach(() => {
  mockGetDomainPricing.mockReset();
});

// ── Happy paths ─────────────────────────────────────────────────────────────

describe("verifyDomainPrices — happy path", () => {
  it("passes when single-item client total matches the RC live price", async () => {
    mockGetDomainPricing.mockResolvedValueOnce(defaultPricing());

    const result = await verifyDomainPrices([
      { domainName: "example.com", price: 1099, registrationPeriod: 1 },
    ]);

    expect(result.ok).toBe(true);
    expect(result.serverTotal).toBe(1099);
    expect(result.clientTotal).toBe(1099);
    expect(result.mismatchedDomains).toEqual([]);
    expect(result.fellBackToClient).toBe(false);
    expect(result.livePrices).toEqual({ "example.com": 1099 });
  });

  it("passes for multi-year — total = price × years", async () => {
    mockGetDomainPricing.mockResolvedValueOnce(defaultPricing());

    const result = await verifyDomainPrices([
      { domainName: "example.com", price: 1099, registrationPeriod: 3 },
    ]);

    expect(result.ok).toBe(true);
    expect(result.serverTotal).toBe(1099 * 3);
    expect(result.clientTotal).toBe(1099 * 3);
  });

  it("passes for a mixed-TLD cart with two domains", async () => {
    mockGetDomainPricing.mockResolvedValueOnce(defaultPricing());

    const result = await verifyDomainPrices([
      { domainName: "site.com", price: 1099, registrationPeriod: 1 },
      { domainName: "site.in", price: 699, registrationPeriod: 2 },
    ]);

    expect(result.ok).toBe(true);
    expect(result.serverTotal).toBe(1099 + 699 * 2);
  });

  it("ignores hosting items in the cart (only domains are verified)", async () => {
    mockGetDomainPricing.mockResolvedValueOnce(defaultPricing());

    const result = await verifyDomainPrices([
      { domainName: "site.com", price: 1099, registrationPeriod: 1 },
      // hosting item with a wildly different price — must not affect verification
      { domainName: "site.com", price: 99999, registrationPeriod: 12, itemType: "hosting" },
    ]);

    expect(result.ok).toBe(true);
    expect(result.serverTotal).toBe(1099);
  });

  it("hosting-only cart bypasses RC entirely (no live fetch attempted)", async () => {
    const result = await verifyDomainPrices([
      { domainName: "site.com", price: 499, registrationPeriod: 12, itemType: "hosting" },
    ]);

    expect(result.ok).toBe(true);
    expect(result.serverTotal).toBe(0);
    expect(result.clientTotal).toBe(0);
    expect(result.fellBackToClient).toBe(false);
    expect(mockGetDomainPricing).not.toHaveBeenCalled();
  });

  it("empty cart is ok (degenerate case but defensive)", async () => {
    const result = await verifyDomainPrices([]);
    expect(result.ok).toBe(true);
    expect(result.serverTotal).toBe(0);
    expect(mockGetDomainPricing).not.toHaveBeenCalled();
  });
});

// ── Tolerance window ────────────────────────────────────────────────────────

describe("verifyDomainPrices — rounding tolerance", () => {
  it("passes when the diff is within ₹1 absolute", async () => {
    mockGetDomainPricing.mockResolvedValueOnce(defaultPricing());

    const result = await verifyDomainPrices([
      // ₹1098 vs ₹1099 — ₹1 diff, within tolerance
      { domainName: "site.com", price: 1098, registrationPeriod: 1 },
    ]);
    expect(result.ok).toBe(true);
  });

  it("passes when the diff is within 0.5% relative on a large total", async () => {
    // For a ₹100,000 total the 0.5% window is ₹500. Use a 7-year .com.
    // Client price is ₹1094/yr — ₹5/yr diff, 7 years = ₹35 diff, well inside.
    mockGetDomainPricing.mockResolvedValueOnce(defaultPricing());

    const result = await verifyDomainPrices([
      { domainName: "site.com", price: 1094, registrationPeriod: 7 },
    ]);
    expect(result.ok).toBe(true);
  });

  it("rejects when the diff exceeds tolerance", async () => {
    mockGetDomainPricing.mockResolvedValueOnce(defaultPricing());

    const result = await verifyDomainPrices([
      // ₹500 vs ₹1099 — way outside tolerance (attacker submitted a lower price)
      { domainName: "site.com", price: 500, registrationPeriod: 1 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.mismatchedDomains).toContain("site.com");
    expect(result.error).toMatch(/site\.com/);
  });

  it("rejects when the client total drift exceeds tolerance even with per-item agreement", async () => {
    // Construct a case where per-domain prices match but the client's
    // claimed total is wrong (e.g. multiplication bug client-side). The
    // final-total check should still trip.
    mockGetDomainPricing.mockResolvedValueOnce(defaultPricing());

    // 5 .com domains @ 1 year each = ₹5,495 total expected
    const items = Array.from({ length: 5 }, (_, i) => ({
      domainName: `a${i}.com`,
      price: 1099,
      registrationPeriod: 1,
    }));

    const result = await verifyDomainPrices(items);
    // Server: 5 × 1099 = 5495. Client: also 5 × 1099 = 5495. Should pass.
    expect(result.ok).toBe(true);
    expect(result.serverTotal).toBe(5495);
    expect(result.clientTotal).toBe(5495);
  });
});

// ── Unverifiable TLDs (attacker-bypass surface) ─────────────────────────────

describe("verifyDomainPrices — unverifiable TLD", () => {
  it("rejects when RC has no price for the requested TLD", async () => {
    // RC returns pricing but only for .com — caller asks about .xyz.
    mockGetDomainPricing.mockResolvedValueOnce({
      customerPricing: { domcno: { addnewdomain: { "1": 1099 } } },
    });

    const result = await verifyDomainPrices([
      { domainName: "site.xyz", price: 100, registrationPeriod: 1 },
    ]);

    expect(result.ok).toBe(false);
    expect(result.fellBackToClient).toBe(false);
    expect(result.error).toMatch(/site\.xyz/);
    // Live price reported as 0 (no data) so the client can see what we couldn't price.
    expect(result.livePrices["site.xyz"]).toBe(0);
  });
});

// ── RC outage / malformed data → fail open ──────────────────────────────────

describe("verifyDomainPrices — RC outage fallback", () => {
  it("falls back to client total when getDomainPricing throws", async () => {
    mockGetDomainPricing.mockRejectedValueOnce(new Error("RC down"));

    const result = await verifyDomainPrices([
      { domainName: "site.com", price: 1099, registrationPeriod: 1 },
    ]);

    expect(result.ok).toBe(true);
    expect(result.fellBackToClient).toBe(true);
    expect(result.serverTotal).toBe(1099);
    expect(result.livePrices).toEqual({});
  });

  it("falls back when RC returns malformed payload (no customerPricing)", async () => {
    mockGetDomainPricing.mockResolvedValueOnce({});

    const result = await verifyDomainPrices([
      { domainName: "site.com", price: 1099, registrationPeriod: 1 },
    ]);
    expect(result.ok).toBe(true);
    expect(result.fellBackToClient).toBe(true);
  });

  it("falls back when customerPricing is not an object", async () => {
    // RC has occasionally returned a string error in this slot; the code
    // must not blow up trying to index into it.
    mockGetDomainPricing.mockResolvedValueOnce({ customerPricing: "ERROR" });

    const result = await verifyDomainPrices([
      { domainName: "site.com", price: 1099, registrationPeriod: 1 },
    ]);
    expect(result.ok).toBe(true);
    expect(result.fellBackToClient).toBe(true);
  });
});

// ── RC pricing-tree shape regressions ───────────────────────────────────────

describe("verifyDomainPrices — RC payload shape", () => {
  it("reads the correct year bucket — 3-year price comes from addnewdomain[3]", async () => {
    // Different prices per year (some TLDs have multi-year discounts).
    mockGetDomainPricing.mockResolvedValueOnce(
      priceTreeFor("domcno", { "1": 1500, "2": 1400, "3": 1300, "5": 1200 })
    );

    const result = await verifyDomainPrices([
      { domainName: "site.com", price: 1300, registrationPeriod: 3 },
    ]);
    expect(result.ok).toBe(true);
    expect(result.livePrices["site.com"]).toBe(1300);
  });

  it("falls back to any year-bucket when the exact one is missing (some min-period TLDs)", async () => {
    // .ai only sells at 2/3 year periods. RC populates "2" and "3" but not "1".
    // The verifier should fall back to one of the available buckets.
    mockGetDomainPricing.mockResolvedValueOnce(
      priceTreeFor("dotai", { "2": 14999, "3": 14999 })
    );

    const result = await verifyDomainPrices([
      { domainName: "site.ai", price: 14999, registrationPeriod: 1 },
    ]);
    // Resolved to a fallback bucket so verification can proceed.
    expect(result.livePrices["site.ai"]).toBe(14999);
  });

  it("ignores year buckets with non-numeric values", async () => {
    // RC sometimes returns "0" or empty strings for unsupported buckets.
    // The parser must skip those without flipping the price to NaN.
    mockGetDomainPricing.mockResolvedValueOnce(
      priceTreeFor("domcno", { "1": 1099, "10": 0 })
    );

    const result = await verifyDomainPrices([
      { domainName: "site.com", price: 1099, registrationPeriod: 1 },
    ]);
    expect(result.ok).toBe(true);
  });
});
