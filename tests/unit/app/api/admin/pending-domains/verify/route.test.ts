/**
 * Tests for `app/api/admin/pending-domains/verify/route.ts` (slice
 * 7hh, part 2). Admin bulk-verifies pending domains by re-querying
 * the registrar.
 *
 * Pins:
 *  - connectDB BEFORE auth
 *  - Admin gate via getAdminFromRequest → 401
 *  - zod schema: domainIds array, min 1, **max 100** (anti-DoS
 *    cap pinned; boundary 100 accepted, 101 rejected)
 *  - PendingDomain query: `{ _id: { $in: domainIds }, status: 'pending' }`
 *    — only currently-pending rows are touched (already-completed
 *    or already-failed rows are NOT re-verified, which would be
 *    pointless and could overwrite a closed status)
 *  - Empty result → 404 'No pending domains found'
 *  - verifyMultipleDomains called with the extracted domainNames
 *  - **3-branch status mapping per result**:
 *      - registrationStatus 'success' → status 'completed', reason
 *        'Domain verification successful - registration completed'
 *      - registrationStatus 'pending' → status STAYS 'pending',
 *        reason updated to result.reason (or unchanged when no
 *        new reason)
 *      - anything else → status 'failed', reason result.reason (or
 *        'Verification failed' fallback)
 *  - verificationAttempts incremented; lastVerifiedAt stamped
 *  - Per-domain save() called
 *  - Response carries verificationResults + updatedDomains +
 *    summary
 *  - Outer catch → 500 'Failed to verify domains' (no leak)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const connectDB = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

const find = vi.hoisted(() => vi.fn());
vi.mock("@/models/PendingDomain", () => ({
  default: { find },
}));

const verifyMultipleDomains = vi.hoisted(() => vi.fn());
const getVerificationSummary = vi.hoisted(() => vi.fn());
vi.mock("@/lib/domain-verification", () => ({
  DomainVerificationService: {
    verifyMultipleDomains,
    getVerificationSummary,
  },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/admin/pending-domains/verify/route";

function makeReq(body: unknown) {
  return new NextRequest(
    "https://example.com/api/admin/pending-domains/verify",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }
  );
}

function pendingDomain(overrides: Record<string, unknown> = {}) {
  return {
    _id: "P1",
    domainName: "example.com",
    status: "pending",
    reason: "Registration in progress",
    verificationAttempts: 2,
    lastVerifiedAt: new Date("2026-06-01"),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  getAdminFromRequest.mockReset();
  connectDB.mockClear().mockResolvedValue(undefined);
  find.mockReset();
  verifyMultipleDomains.mockReset();
  getVerificationSummary.mockReset().mockReturnValue({});
});

describe("Admin gate (after connectDB)", () => {
  it("non-admin → 401; NO domain query", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ domainIds: ["P1"] }));
    expect(res.status).toBe(401);
    expect(connectDB).toHaveBeenCalled(); // ordering: DB first
    expect(find).not.toHaveBeenCalled();
  });
});

describe("Body validation (100-cap anti-DoS)", () => {
  beforeEach(() => {
    getAdminFromRequest.mockResolvedValue({ _id: "A1" });
  });

  it("missing domainIds → 400", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
  });

  it("empty domainIds → 400 (min:1)", async () => {
    const res = await POST(makeReq({ domainIds: [] }));
    expect(res.status).toBe(400);
  });

  it("domainIds.length > 100 → 400 (anti-DoS cap)", async () => {
    const big = Array.from({ length: 101 }, (_, i) => `P${i}`);
    const res = await POST(makeReq({ domainIds: big }));
    expect(res.status).toBe(400);
    expect(find).not.toHaveBeenCalled();
  });

  it("domainIds.length === 100 → accepted (boundary)", async () => {
    const onehundred = Array.from({ length: 100 }, (_, i) => `P${i}`);
    find.mockResolvedValueOnce([pendingDomain()]);
    verifyMultipleDomains.mockResolvedValueOnce([]);

    const res = await POST(makeReq({ domainIds: onehundred }));
    expect(res.status).toBe(200);
  });
});

describe("Pending-only query", () => {
  it("PendingDomain.find filter pinned: `{ _id: { $in: domainIds }, status: 'pending' }` — already-completed / failed rows NOT touched", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    find.mockResolvedValueOnce([]);

    await POST(makeReq({ domainIds: ["P1", "P2"] }));
    expect(find).toHaveBeenCalledWith({
      _id: { $in: ["P1", "P2"] },
      status: "pending",
    });
  });

  it("no matching pending domains → 404 'No pending domains found'", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    find.mockResolvedValueOnce([]);

    const res = await POST(makeReq({ domainIds: ["P_NONE"] }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("No pending domains found");
    expect(verifyMultipleDomains).not.toHaveBeenCalled();
  });
});

describe("3-branch status mapping per verification result", () => {
  beforeEach(() => {
    getAdminFromRequest.mockResolvedValue({ _id: "A1" });
  });

  it("'success' → status:'completed', reason:'... registration completed'", async () => {
    const d = pendingDomain({ domainName: "ok.com" });
    find.mockResolvedValueOnce([d]);
    verifyMultipleDomains.mockResolvedValueOnce([
      { domainName: "ok.com", registrationStatus: "success" },
    ]);

    await POST(makeReq({ domainIds: ["P1"] }));
    expect(d.status).toBe("completed");
    expect(d.reason).toBe(
      "Domain verification successful - registration completed"
    );
    expect(d.save).toHaveBeenCalled();
  });

  it("'pending' (still in progress at registrar) → status STAYS 'pending', reason updated when new one provided", async () => {
    const d = pendingDomain({
      domainName: "wait.com",
      reason: "Old reason",
    });
    find.mockResolvedValueOnce([d]);
    verifyMultipleDomains.mockResolvedValueOnce([
      {
        domainName: "wait.com",
        registrationStatus: "pending",
        reason: "Still awaiting EPP code",
      },
    ]);

    await POST(makeReq({ domainIds: ["P1"] }));
    expect(d.status).toBe("pending"); // unchanged
    expect(d.reason).toBe("Still awaiting EPP code");
  });

  it("'pending' with no new reason → keeps old reason", async () => {
    const d = pendingDomain({
      domainName: "wait.com",
      reason: "Original reason kept",
    });
    find.mockResolvedValueOnce([d]);
    verifyMultipleDomains.mockResolvedValueOnce([
      { domainName: "wait.com", registrationStatus: "pending" }, // no reason
    ]);

    await POST(makeReq({ domainIds: ["P1"] }));
    expect(d.status).toBe("pending");
    expect(d.reason).toBe("Original reason kept");
  });

  it("else (failed) → status:'failed', reason:result.reason", async () => {
    const d = pendingDomain({ domainName: "broken.com" });
    find.mockResolvedValueOnce([d]);
    verifyMultipleDomains.mockResolvedValueOnce([
      {
        domainName: "broken.com",
        registrationStatus: "error",
        reason: "Registrar returned 503",
      },
    ]);

    await POST(makeReq({ domainIds: ["P1"] }));
    expect(d.status).toBe("failed");
    expect(d.reason).toBe("Registrar returned 503");
  });

  it("else (failed) with no reason → 'Verification failed' fallback", async () => {
    const d = pendingDomain({ domainName: "broken.com" });
    find.mockResolvedValueOnce([d]);
    verifyMultipleDomains.mockResolvedValueOnce([
      { domainName: "broken.com", registrationStatus: "error" },
    ]);

    await POST(makeReq({ domainIds: ["P1"] }));
    expect(d.status).toBe("failed");
    expect(d.reason).toBe("Verification failed");
  });
});

describe("Verification counter + timestamp", () => {
  it("verificationAttempts incremented + lastVerifiedAt stamped on every result", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    const d = pendingDomain({
      domainName: "x.com",
      verificationAttempts: 2,
    });
    find.mockResolvedValueOnce([d]);
    verifyMultipleDomains.mockResolvedValueOnce([
      { domainName: "x.com", registrationStatus: "pending" },
    ]);

    await POST(makeReq({ domainIds: ["P1"] }));
    expect(d.verificationAttempts).toBe(3);
    expect(d.lastVerifiedAt).toBeInstanceOf(Date);
  });
});

describe("Response shape", () => {
  it("returns {success, message, verificationResults, updatedDomains, summary}", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    const d = pendingDomain({ domainName: "ok.com" });
    find.mockResolvedValueOnce([d]);
    const results = [{ domainName: "ok.com", registrationStatus: "success" }];
    verifyMultipleDomains.mockResolvedValueOnce(results);
    const summary = { completed: 1, pending: 0, failed: 0 };
    getVerificationSummary.mockReturnValueOnce(summary);

    const res = await POST(makeReq({ domainIds: ["P1"] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toBe("Domain verification completed");
    expect(body.verificationResults).toEqual(results);
    expect(body.summary).toEqual(summary);
  });
});

describe("Outer catch", () => {
  it("connectDB throw → 500 'Failed to verify domains'", async () => {
    connectDB.mockRejectedValueOnce(new Error("Mongo down"));
    const res = await POST(makeReq({ domainIds: ["P1"] }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to verify domains");
    expect(body.error).not.toContain("Mongo");
  });
});
