/**
 * Tests for `@/lib/services/payment/provisioner-verification` (rescan-4
 * slice 7fa). The post-provisioning verification + PendingDomain
 * materialization phase. Pins:
 *  - Hosting items SKIPPED from verifyMultipleDomains call
 *  - **Pending/failed non-hosting items → PendingDomain row created**
 *    (the dashboard would otherwise lose "failed" rows that were
 *    previously invisible to admin)
 *  - **'registered' rows that the verifier flags as still-available**
 *    → orderDomain.status FLIPPED to 'pending' + cleanup Domain row +
 *    PendingDomain row queued (the silent-failure detection — RC said
 *    success but registry still shows available = registry didn't
 *    actually register, likely insufficient-funds)
 *  - Domain.deleteOne cleanup failure is SWALLOWED (logged + continue
 *    queueing — never abort the verify phase on a cleanup blip)
 *  - **Bulk upsert filter is (domainName, userId)** — NOT domainName
 *    alone (the previous bug let one user's failure overwrite another
 *    user's PendingDomain row); documented anti-regression
 *  - PendingDomain.bulkWrite failure is logged + swallowed (never
 *    blocks the payment-verify response)
 *  - Empty pendingDomainsToCreate → early return (no bulkWrite call)
 *  - PendingDomain payload uses ctx.customerResult.contactId for all 3
 *    contact roles (admin/tech/billing) — single-contact convention
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyMultipleDomains = vi.hoisted(() => vi.fn());
const isPendingRegistration = vi.hoisted(() => vi.fn());
vi.mock("@/lib/domain-verification", () => ({
  DomainVerificationService: {
    verifyMultipleDomains,
    isPendingRegistration,
  },
}));

const domainDeleteOne = vi.hoisted(() => vi.fn());
vi.mock("@/models/Domain", () => ({
  default: { deleteOne: domainDeleteOne },
}));

const pendingBulkWrite = vi.hoisted(() => vi.fn());
vi.mock("@/models/PendingDomain", () => ({
  default: { bulkWrite: pendingBulkWrite },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { runDomainVerificationPhase } from "@/lib/services/payment/provisioner-verification";

beforeEach(() => {
  verifyMultipleDomains.mockReset();
  isPendingRegistration.mockReset();
  domainDeleteOne.mockReset();
  pendingBulkWrite.mockReset();
});

const CTX: Record<string, unknown> = {
  user: { _id: "USER_ID" },
  orderId: "ord_42",
  customerResult: { customerId: 7, contactId: 100 },
};

describe("runDomainVerificationPhase — verifier-call gating", () => {
  it("hosting items SKIPPED from verifyMultipleDomains call", async () => {
    verifyMultipleDomains.mockResolvedValueOnce([]);
    await runDomainVerificationPhase(
      [
        { domainName: "x.com", status: "registered", itemType: "domain" } as never,
        { domainName: "hosting-1", status: "active", itemType: "hosting" } as never,
        { domainName: "y.com", status: "registered", itemType: "domain" } as never,
      ],
      CTX as never
    );
    expect(verifyMultipleDomains).toHaveBeenCalledWith(["x.com", "y.com"]);
  });

  it("no domain items (hosting-only) → NO verify call", async () => {
    await runDomainVerificationPhase(
      [{ domainName: "hosting-1", status: "active", itemType: "hosting" } as never],
      CTX as never
    );
    expect(verifyMultipleDomains).not.toHaveBeenCalled();
  });

  it("empty cart → early return, no bulkWrite", async () => {
    await runDomainVerificationPhase([], CTX as never);
    expect(pendingBulkWrite).not.toHaveBeenCalled();
  });
});

describe("runDomainVerificationPhase — pending/failed → PendingDomain rows", () => {
  it("'pending' non-hosting domain → bulk-write PendingDomain payload with status:'pending' + default reason", async () => {
    verifyMultipleDomains.mockResolvedValueOnce([]);
    pendingBulkWrite.mockResolvedValueOnce({
      upsertedCount: 1,
      modifiedCount: 0,
    });
    await runDomainVerificationPhase(
      [
        {
          domainName: "x.com",
          status: "pending",
          itemType: "domain",
          price: 500,
          currency: "INR",
          registrationPeriod: 1,
        } as never,
      ],
      CTX as never
    );
    const [bulkOps] = pendingBulkWrite.mock.calls[0];
    expect(bulkOps).toHaveLength(1);
    expect(bulkOps[0].updateOne.update.$set.domainName).toBe("x.com");
    expect(bulkOps[0].updateOne.update.$set.status).toBe("pending");
    expect(bulkOps[0].updateOne.update.$set.reason).toMatch(
      /registration pending.*manual processing/i
    );
    expect(bulkOps[0].updateOne.update.$set.verificationAttempts).toBe(0);
  });

  it("'failed' non-hosting domain → PendingDomain with status:'failed' + failure reason", async () => {
    verifyMultipleDomains.mockResolvedValueOnce([]);
    pendingBulkWrite.mockResolvedValueOnce({
      upsertedCount: 1,
      modifiedCount: 0,
    });
    await runDomainVerificationPhase(
      [
        {
          domainName: "y.com",
          status: "failed",
          itemType: "domain",
          error: "Domain forbidden TLD",
        } as never,
      ],
      CTX as never
    );
    const [bulkOps] = pendingBulkWrite.mock.calls[0];
    expect(bulkOps[0].updateOne.update.$set.status).toBe("failed");
    // orderDomain.error preferred over default reason
    expect(bulkOps[0].updateOne.update.$set.reason).toBe("Domain forbidden TLD");
  });

  it("'pending' HOSTING domain → SKIPPED (only non-hosting items become PendingDomain rows)", async () => {
    verifyMultipleDomains.mockResolvedValueOnce([]);
    await runDomainVerificationPhase(
      [
        {
          domainName: "hosting-1",
          status: "pending",
          itemType: "hosting",
        } as never,
      ],
      CTX as never
    );
    expect(pendingBulkWrite).not.toHaveBeenCalled();
  });
});

describe("runDomainVerificationPhase — silent-failure detection", () => {
  it("'registered' + verifier flags as pending → status FLIPPED to 'pending' + Domain cleanup + PendingDomain queued", async () => {
    const orderDomains: Array<Record<string, unknown>> = [
      {
        domainName: "x.com",
        status: "registered",
        itemType: "domain",
      },
    ];
    verifyMultipleDomains.mockResolvedValueOnce([
      {
        domainName: "x.com",
        isAvailable: true,
        registrationStatus: "pending",
        reason: "Domain still available",
      },
    ]);
    isPendingRegistration.mockReturnValueOnce(true);
    domainDeleteOne.mockResolvedValueOnce({});
    pendingBulkWrite.mockResolvedValueOnce({
      upsertedCount: 1,
      modifiedCount: 0,
    });
    await runDomainVerificationPhase(orderDomains as never, CTX as never);
    // status mutated in-place
    expect(orderDomains[0].status).toBe("pending");
    // optimistic Domain insert cleaned up
    expect(domainDeleteOne).toHaveBeenCalledWith({
      domainName: "x.com",
      orderId: "ord_42",
    });
    // PendingDomain queued with verificationAttempts:1 (we attempted)
    const [bulkOps] = pendingBulkWrite.mock.calls[0];
    expect(bulkOps[0].updateOne.update.$set.verificationAttempts).toBe(1);
    expect(bulkOps[0].updateOne.update.$set.reason).toBe(
      "Domain still available"
    );
  });

  it("'registered' + verifier 'success' → NO mutation, NO cleanup, NO PendingDomain", async () => {
    const orderDomains: Array<Record<string, unknown>> = [
      {
        domainName: "x.com",
        status: "registered",
        itemType: "domain",
      },
    ];
    verifyMultipleDomains.mockResolvedValueOnce([
      {
        domainName: "x.com",
        isAvailable: false,
        registrationStatus: "success",
      },
    ]);
    isPendingRegistration.mockReturnValueOnce(false);
    await runDomainVerificationPhase(orderDomains as never, CTX as never);
    expect(orderDomains[0].status).toBe("registered"); // unchanged
    expect(domainDeleteOne).not.toHaveBeenCalled();
    expect(pendingBulkWrite).not.toHaveBeenCalled();
  });

  it("Domain.deleteOne cleanup failure SWALLOWED — PendingDomain still queued", async () => {
    verifyMultipleDomains.mockResolvedValueOnce([
      {
        domainName: "x.com",
        registrationStatus: "pending",
        reason: "still available",
      },
    ]);
    isPendingRegistration.mockReturnValueOnce(true);
    domainDeleteOne.mockRejectedValueOnce(new Error("transient db error"));
    pendingBulkWrite.mockResolvedValueOnce({
      upsertedCount: 1,
      modifiedCount: 0,
    });
    await expect(
      runDomainVerificationPhase(
        [
          {
            domainName: "x.com",
            status: "registered",
            itemType: "domain",
          } as never,
        ],
        CTX as never
      )
    ).resolves.toBeUndefined();
    expect(pendingBulkWrite).toHaveBeenCalled();
  });
});

describe("PendingDomain.bulkWrite — filter shape + error handling", () => {
  it("upsert filter is (domainName, userId) — NOT domainName alone (anti-regression)", async () => {
    verifyMultipleDomains.mockResolvedValueOnce([]);
    pendingBulkWrite.mockResolvedValueOnce({
      upsertedCount: 1,
      modifiedCount: 0,
    });
    await runDomainVerificationPhase(
      [
        {
          domainName: "shared.com",
          status: "failed",
          itemType: "domain",
        } as never,
      ],
      CTX as never
    );
    const [bulkOps] = pendingBulkWrite.mock.calls[0];
    // filter must include BOTH fields — prevents one user's failure
    // from clobbering another user's row keyed on the same domain.
    expect(bulkOps[0].updateOne.filter).toEqual({
      domainName: "shared.com",
      userId: "USER_ID",
    });
    expect(bulkOps[0].updateOne.upsert).toBe(true);
  });

  it("bulkWrite failure → swallowed + logged (never blocks payment-verify response)", async () => {
    verifyMultipleDomains.mockResolvedValueOnce([]);
    pendingBulkWrite.mockRejectedValueOnce(new Error("E11000 dup key"));
    await expect(
      runDomainVerificationPhase(
        [
          { domainName: "x.com", status: "failed", itemType: "domain" } as never,
        ],
        CTX as never
      )
    ).resolves.toBeUndefined();
  });
});

describe("PendingDomain payload shape", () => {
  it("uses ctx.customerResult.contactId for ALL 3 contact roles (single-contact convention)", async () => {
    verifyMultipleDomains.mockResolvedValueOnce([]);
    pendingBulkWrite.mockResolvedValueOnce({
      upsertedCount: 1,
      modifiedCount: 0,
    });
    await runDomainVerificationPhase(
      [
        {
          domainName: "x.com",
          status: "pending",
          itemType: "domain",
          price: 500,
          resellerClubCustomerId: 7,
          resellerClubContactId: 100,
          resellerClubOrderId: 99999,
        } as never,
      ],
      CTX as never
    );
    const set = pendingBulkWrite.mock.calls[0][0][0].updateOne.update.$set;
    expect(set.adminContactId).toBe(100);
    expect(set.techContactId).toBe(100);
    expect(set.billingContactId).toBe(100);
    expect(set.customerId).toBe(7);
    expect(set.contactId).toBe(100);
    expect(set.resellerClubOrderId).toBe(99999);
    expect(set.lastVerifiedAt).toBeInstanceOf(Date);
  });

  it("user._id stringified for the userId field", async () => {
    verifyMultipleDomains.mockResolvedValueOnce([]);
    pendingBulkWrite.mockResolvedValueOnce({
      upsertedCount: 1,
      modifiedCount: 0,
    });
    await runDomainVerificationPhase(
      [
        { domainName: "x.com", status: "pending", itemType: "domain" } as never,
      ],
      {
        ...CTX,
        user: { _id: { toString: () => "STRINGIFIED_ID" } },
      } as never
    );
    expect(
      pendingBulkWrite.mock.calls[0][0][0].updateOne.update.$set.userId
    ).toBe("STRINGIFIED_ID");
  });
});
