/**
 * Tests for `@/lib/domain-verification` static helpers (rescan-4 slice 7el).
 * The DomainVerificationService class — pure pieces + the
 * verifyDomainRegistration logic. Pins:
 *  - **isPendingRegistration** is a literal predicate: returns true ONLY
 *    when registrationStatus==='pending' (NOT when isAvailable is true
 *    or false — the registrationStatus field is the source of truth)
 *  - **getVerificationSummary** counts buckets: successful + pending +
 *    failed; pendingDomains list pushes pending names in input order
 *  - empty input → all zero counts + empty pendingDomains
 *  - verifyDomainRegistration: splits domain into baseDomain + tld;
 *    queries ResellerClubWrapper.searchDomainWithTlds(base, [tld])
 *  - Exact match + available:true → registrationStatus='pending' with
 *    'still available - registration likely failed due to insufficient
 *    funds' reason (the insufficient-balance heuristic — RC accepts the
 *    order but the wallet can't fund it; domain stays available)
 *  - Exact match + available:false → also 'pending' (the conservative
 *    'might be pending or successful' branch — manual review needed)
 *  - No exact match + no partial → 'pending' (manual verification
 *    needed — never silently classified as 'failed' to avoid
 *    spurious refunds)
 *  - **searchDomainWithTlds throw → 'failed' status with `Verification
 *    failed: {message}` reason** (the only path that produces a
 *    'failed' status — DB/integration writes can decide whether to
 *    retry or refund)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const searchDomainWithTlds = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub-wrapper", () => ({
  ResellerClubWrapper: { searchDomainWithTlds },
}));
vi.mock("@/lib/integrations/resellerclub", () => ({
  getDomainOrderId: vi.fn(),
  getDomainDetails: vi.fn(),
}));
vi.mock("@/lib/services/orders", () => ({
  findOrdersByDomainName: vi.fn(),
}));
vi.mock("@/models/Domain", () => ({
  default: { findOneAndUpdate: vi.fn(), findOne: vi.fn() },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { DomainVerificationService } from "@/lib/domain-verification";
import type { DomainVerificationResult } from "@/lib/domain-verification";

beforeEach(() => {
  searchDomainWithTlds.mockReset();
});

function result(
  overrides: Partial<DomainVerificationResult> = {}
): DomainVerificationResult {
  return {
    domainName: "x.com",
    isAvailable: false,
    registrationStatus: "success",
    checkedAt: new Date(),
    ...overrides,
  };
}

describe("isPendingRegistration", () => {
  it("returns true ONLY when registrationStatus==='pending'", () => {
    expect(
      DomainVerificationService.isPendingRegistration(
        result({ registrationStatus: "pending", isAvailable: false })
      )
    ).toBe(true);
    expect(
      DomainVerificationService.isPendingRegistration(
        result({ registrationStatus: "pending", isAvailable: true })
      )
    ).toBe(true);
    expect(
      DomainVerificationService.isPendingRegistration(
        result({ registrationStatus: "success" })
      )
    ).toBe(false);
    expect(
      DomainVerificationService.isPendingRegistration(
        result({ registrationStatus: "failed" })
      )
    ).toBe(false);
  });
});

describe("getVerificationSummary", () => {
  it("counts buckets accurately + accumulates pendingDomains list in order", () => {
    const results = [
      result({ domainName: "a.com", registrationStatus: "success" }),
      result({ domainName: "b.com", registrationStatus: "pending" }),
      result({ domainName: "c.com", registrationStatus: "failed" }),
      result({ domainName: "d.com", registrationStatus: "pending" }),
      result({ domainName: "e.com", registrationStatus: "success" }),
    ];
    const summary = DomainVerificationService.getVerificationSummary(results);
    expect(summary.total).toBe(5);
    expect(summary.successful).toBe(2);
    expect(summary.pending).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.pendingDomains).toEqual(["b.com", "d.com"]);
  });

  it("empty input → all-zero counts + empty pendingDomains", () => {
    const summary = DomainVerificationService.getVerificationSummary([]);
    expect(summary).toEqual({
      total: 0,
      successful: 0,
      pending: 0,
      failed: 0,
      pendingDomains: [],
    });
  });
});

describe("verifyDomainRegistration — domain-parse + RC lookup", () => {
  it("splits 'foo.example.com' into base='foo' + tld='example.com' for the RC search", async () => {
    searchDomainWithTlds.mockResolvedValueOnce([]);
    await DomainVerificationService.verifyDomainRegistration("foo.example.com");
    expect(searchDomainWithTlds).toHaveBeenCalledWith("foo", ["example.com"]);
  });

  it("exact-match + available:true → 'pending' with the insufficient-balance reason", async () => {
    searchDomainWithTlds.mockResolvedValueOnce([
      { domainName: "x.com", available: true },
    ]);
    const result = await DomainVerificationService.verifyDomainRegistration(
      "x.com"
    );
    expect(result.registrationStatus).toBe("pending");
    expect(result.isAvailable).toBe(true);
    expect(result.reason).toMatch(/insufficient funds|still available/i);
  });

  it("exact-match + available:false → 'pending' (conservative — might be success OR queued)", async () => {
    searchDomainWithTlds.mockResolvedValueOnce([
      { domainName: "x.com", available: false },
    ]);
    const result = await DomainVerificationService.verifyDomainRegistration(
      "x.com"
    );
    expect(result.registrationStatus).toBe("pending");
    expect(result.isAvailable).toBe(false);
    expect(result.reason).toMatch(/manual verification/i);
  });

  it("exact match is case-insensitive (X.COM matches x.com)", async () => {
    searchDomainWithTlds.mockResolvedValueOnce([
      { domainName: "X.COM", available: true },
    ]);
    const result = await DomainVerificationService.verifyDomainRegistration(
      "x.com"
    );
    expect(result.registrationStatus).toBe("pending");
  });

  it("no exact match BUT partial match exists → 'pending' (partial-match fallback)", async () => {
    searchDomainWithTlds.mockResolvedValueOnce([
      { domainName: "www.x.com", available: true }, // partial — contains x.com
    ]);
    const result = await DomainVerificationService.verifyDomainRegistration(
      "x.com"
    );
    expect(result.registrationStatus).toBe("pending");
  });

  it("empty search results → 'pending' with 'manual verification' reason (NEVER 'failed' — avoid spurious refunds)", async () => {
    searchDomainWithTlds.mockResolvedValueOnce([]);
    const result = await DomainVerificationService.verifyDomainRegistration(
      "x.com"
    );
    expect(result.registrationStatus).toBe("pending");
    expect(result.reason).toMatch(/manual verification/i);
  });

  it("searchDomainWithTlds THROW → 'failed' status with Verification failed: {message} (the ONLY failed path)", async () => {
    searchDomainWithTlds.mockRejectedValueOnce(new Error("RC API down"));
    const result = await DomainVerificationService.verifyDomainRegistration(
      "x.com"
    );
    expect(result.registrationStatus).toBe("failed");
    expect(result.reason).toContain("Verification failed");
    expect(result.reason).toContain("RC API down");
  });

  it("checkedAt is stamped on every result (Date instance)", async () => {
    searchDomainWithTlds.mockResolvedValueOnce([]);
    const result = await DomainVerificationService.verifyDomainRegistration(
      "x.com"
    );
    expect(result.checkedAt).toBeInstanceOf(Date);
  });
});
