/**
 * Tests for the deferred-hosting provisioning lifecycle.
 *
 * provisionPendingHosting() is the shared retry path that both the admin
 * "Retry" button and the auto-retry cron call. Closing the loop on the
 * 2026-05-19 DA-deferral change: when DA was unreachable at checkout-time,
 * the provisioner writes a PendingHosting row with status:"pending". This
 * function drains those rows once DA recovers.
 *
 * The flow is six steps; each failure mode needs an explicit test because
 * the function partially commits (DA → user fields → Hosting row → email)
 * and a regression in the middle could leave the DB in a half-state:
 *
 *   1. User-resolution: missing user → fail cleanly without touching DA.
 *   2. Already-provisioned-elsewhere: drop the row (don't double-provision).
 *   3. DA createUser still-throws (DA still down) → re-stamp pending.error,
 *      DO NOT touch user fields or write Hosting row. Re-runs OK next tick.
 *   4. DA succeeds + DNS step throws: log + continue (DNS is best-effort).
 *   5. DA succeeds + Hosting.create throws: log + continue (the user has
 *      a live DA account already, refusing to delete the PendingHosting
 *      row would be worse).
 *   6. Email failure on success: log + continue (email is fire-and-forget).
 *
 * Tests mock all five injected dependencies (User service, DirectAdmin,
 * Email, server-logger, Hosting model) so the real provisionPendingHosting
 * function is exercised against deterministic stubs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────────────
// Set up the mock surface up front so the dynamic imports inside
// provisionPendingHosting resolve to our test doubles. Using vi.hoisted +
// vi.mock to keep the references stable across factory calls.

const { mockUser, mockHostingCreate, mockDAState, mockEmailState, mockPendingHostingDelete } =
  vi.hoisted(() => ({
    mockUser: {
      // Mutable so individual tests can flip directAdminUsername / saveThrows etc.
      current: null as null | {
        _id: string;
        email: string;
        firstName?: string;
        directAdminUsername?: string;
        hostingCreatedAt?: Date;
        hostingExpiresAt?: Date;
        save: () => Promise<void>;
      },
    },
    mockHostingCreate: { fn: vi.fn(), throws: false },
    mockDAState: {
      createUserThrows: false,
      updateDnsThrows: false,
      createUserCalls: 0,
      updateDnsCalls: 0,
    },
    mockEmailState: { throws: false, calls: 0 },
    mockPendingHostingDelete: { calls: 0 },
  }));

vi.mock("@/lib/services/users", () => ({
  getUserById: vi.fn(async (_id: string) => mockUser.current),
}));

vi.mock("@/lib/directadmin", () => ({
  DirectAdminService: {
    NAMESERVERS: ["ns1.example.com", "ns2.example.com"],
    createUser: vi.fn(async () => {
      mockDAState.createUserCalls += 1;
      if (mockDAState.createUserThrows) throw new Error("DA still unreachable");
    }),
    updateDNSNameservers: vi.fn(async () => {
      mockDAState.updateDnsCalls += 1;
      if (mockDAState.updateDnsThrows) throw new Error("DNS API failed");
    }),
  },
}));

vi.mock("@/lib/email", () => ({
  EmailService: {
    sendHostingProvisionedEmail: vi.fn(async () => {
      mockEmailState.calls += 1;
      if (mockEmailState.throws) throw new Error("SMTP down");
    }),
  },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), log: vi.fn() },
}));

// Mongo connector is no-op in tests.
vi.mock("@/lib/mongodb", () => ({ default: vi.fn(async () => {}) }));

// Hosting model — capture create() args.
vi.mock("@/models/Hosting", () => ({
  default: {
    create: vi.fn(async (doc: unknown) => {
      mockHostingCreate.fn(doc);
      if (mockHostingCreate.throws) throw new Error("Mongo write failed");
      return doc;
    }),
  },
}));

// PendingHosting — only `findByIdAndDelete` is touched from the function.
vi.mock("@/models/PendingHosting", () => ({
  default: {
    findByIdAndDelete: vi.fn(async (_id: unknown) => {
      mockPendingHostingDelete.calls += 1;
      return null;
    }),
  },
}));

import { provisionPendingHosting } from "@/lib/services/pending-hostings";
import type { IPendingHosting } from "@/models/PendingHosting";

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Build a minimal IPendingHosting test double — only fields the function reads. */
function pendingRow(overrides: Partial<IPendingHosting> = {}): IPendingHosting {
  return {
    _id: "pending-id-123",
    userId: "user-1",
    domain: "example.com",
    package: "standard",
    daUsername: "user1da",
    error: "DA timeout from earlier",
    status: "pending",
    save: vi.fn(async () => {}),
    ...overrides,
  } as unknown as IPendingHosting;
}

function freshUser(overrides: Record<string, unknown> = {}) {
  return {
    _id: "user-1",
    email: "user1@example.com",
    firstName: "Test",
    directAdminUsername: undefined,
    save: vi.fn(async () => {}),
    ...overrides,
  };
}

beforeEach(() => {
  mockUser.current = freshUser();
  mockDAState.createUserThrows = false;
  mockDAState.updateDnsThrows = false;
  mockDAState.createUserCalls = 0;
  mockDAState.updateDnsCalls = 0;
  mockHostingCreate.throws = false;
  mockHostingCreate.fn = vi.fn();
  mockEmailState.throws = false;
  mockEmailState.calls = 0;
  mockPendingHostingDelete.calls = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Happy path: full provision succeeds ─────────────────────────────────────

describe("provisionPendingHosting — happy path", () => {
  it("provisions DA, stamps user, writes Hosting row, drops Pending row, sends email", async () => {
    const result = await provisionPendingHosting(pendingRow());

    expect(result.ok).toBe(true);
    expect(result.dropped).toBeUndefined();
    expect(result.domain).toBe("example.com");

    // DA createUser was called once
    expect(mockDAState.createUserCalls).toBe(1);
    // Nameserver update was attempted
    expect(mockDAState.updateDnsCalls).toBe(1);
    // User fields stamped (directAdminUsername + hostingCreatedAt/ExpiresAt)
    expect(mockUser.current!.directAdminUsername).toBe("user1da");
    expect(mockUser.current!.hostingCreatedAt).toBeInstanceOf(Date);
    expect(mockUser.current!.hostingExpiresAt).toBeInstanceOf(Date);
    expect(mockUser.current!.save).toHaveBeenCalled();
    // Hosting row written with the right shape
    expect(mockHostingCreate.fn).toHaveBeenCalledTimes(1);
    const hostingDoc = mockHostingCreate.fn.mock.calls[0][0] as Record<string, unknown>;
    expect(hostingDoc.userId).toBe("user-1");
    expect(hostingDoc.domainName).toBe("example.com");
    expect(hostingDoc.directAdminUsername).toBe("user1da");
    expect(hostingDoc.status).toBe("active");
    expect(hostingDoc.isTrial).toBe(false);
    expect(hostingDoc.autoRenew).toBe(false);
    expect((hostingDoc.orderId as string).startsWith("retry_")).toBe(true);
    // Pending row was deleted
    expect(mockPendingHostingDelete.calls).toBe(1);
    // Email was sent
    expect(mockEmailState.calls).toBe(1);
  });

  it("expiry is set 365 days out (matches the annual hosting contract)", async () => {
    const before = Date.now();
    await provisionPendingHosting(pendingRow());
    const exp = mockUser.current!.hostingExpiresAt!.getTime();
    const oneYearMs = 365 * 24 * 60 * 60 * 1000;
    expect(exp - before).toBeGreaterThanOrEqual(oneYearMs - 5000);
    expect(exp - before).toBeLessThanOrEqual(oneYearMs + 5000);
  });
});

// ── User resolution ─────────────────────────────────────────────────────────

describe("provisionPendingHosting — user resolution", () => {
  it("fails cleanly when the user no longer exists (no DA call)", async () => {
    mockUser.current = null;

    const result = await provisionPendingHosting(pendingRow());

    expect(result.ok).toBe(false);
    expect(result.error).toBe("User not found");
    // No DA work attempted — fail-fast before any side effects.
    expect(mockDAState.createUserCalls).toBe(0);
    expect(mockHostingCreate.fn).not.toHaveBeenCalled();
    expect(mockPendingHostingDelete.calls).toBe(0);
  });

  it("drops the row when the user already has a directAdminUsername (provisioned elsewhere)", async () => {
    mockUser.current = freshUser({ directAdminUsername: "user1da" });

    const result = await provisionPendingHosting(pendingRow());

    expect(result.ok).toBe(true);
    expect(result.dropped).toBe(true);
    // No DA call — refuse to double-provision.
    expect(mockDAState.createUserCalls).toBe(0);
    // PendingHosting row was deleted so future cron ticks don't re-attempt.
    expect(mockPendingHostingDelete.calls).toBe(1);
    // No "your hosting is live" email — they already got one when the
    // earlier provision succeeded.
    expect(mockEmailState.calls).toBe(0);
  });
});

// ── DA still down ───────────────────────────────────────────────────────────

describe("provisionPendingHosting — DA still unreachable", () => {
  it("returns { ok: false } and re-stamps the pending row's error", async () => {
    mockDAState.createUserThrows = true;
    const row = pendingRow();

    const result = await provisionPendingHosting(row);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("DA still unreachable");
    // pending.error rewritten so the admin view shows the latest reason.
    expect(row.error).toBe("DA still unreachable");
    expect(row.save).toHaveBeenCalled();

    // CRITICAL: when DA fails, no user fields written + no Hosting row +
    // no PendingHosting deletion + no email. Re-runs OK next tick.
    expect(mockUser.current!.directAdminUsername).toBeUndefined();
    expect(mockUser.current!.save).not.toHaveBeenCalled();
    expect(mockHostingCreate.fn).not.toHaveBeenCalled();
    expect(mockPendingHostingDelete.calls).toBe(0);
    expect(mockEmailState.calls).toBe(0);
  });
});

// ── Partial failures after DA succeeds (must still report ok: true) ─────────

describe("provisionPendingHosting — DA-then-X partial failure", () => {
  it("continues when DNS update throws (DNS is best-effort)", async () => {
    mockDAState.updateDnsThrows = true;

    const result = await provisionPendingHosting(pendingRow());

    expect(result.ok).toBe(true);
    // User fields + Hosting + delete + email all still happen.
    expect(mockUser.current!.directAdminUsername).toBe("user1da");
    expect(mockHostingCreate.fn).toHaveBeenCalled();
    expect(mockPendingHostingDelete.calls).toBe(1);
    expect(mockEmailState.calls).toBe(1);
  });

  it("continues when Hosting.create throws (DA account exists, don't refuse cleanup)", async () => {
    // SAFETY-CRITICAL: if Hosting.create throws and we leave the Pending row
    // in place, the next cron tick re-runs DA createUser which errors out
    // with "user already exists" and re-stamps the row's error. This puts
    // the user in a permanently failed state even though they have live
    // hosting. The correct behaviour is to log + continue.
    mockHostingCreate.throws = true;

    const result = await provisionPendingHosting(pendingRow());

    expect(result.ok).toBe(true);
    expect(mockUser.current!.directAdminUsername).toBe("user1da");
    expect(mockPendingHostingDelete.calls).toBe(1);
    expect(mockEmailState.calls).toBe(1);
  });

  it("continues when notification email throws (post-success, log only)", async () => {
    mockEmailState.throws = true;

    const result = await provisionPendingHosting(pendingRow());

    expect(result.ok).toBe(true);
    // Everything else completed before the email attempt.
    expect(mockUser.current!.directAdminUsername).toBe("user1da");
    expect(mockHostingCreate.fn).toHaveBeenCalled();
    expect(mockPendingHostingDelete.calls).toBe(1);
  });
});

// ── Idempotency-ish properties ──────────────────────────────────────────────

describe("provisionPendingHosting — properties", () => {
  it("the Hosting row's directAdminUsername matches the PendingHosting daUsername", async () => {
    // SECURITY-CRITICAL: a mismatch here means the auto-renewal +
    // suspend-on-expiry cron would target the wrong DA account.
    await provisionPendingHosting(pendingRow({ daUsername: "u_specific_999" } as Partial<IPendingHosting>));
    const doc = mockHostingCreate.fn.mock.calls[0][0] as Record<string, unknown>;
    expect(doc.directAdminUsername).toBe("u_specific_999");
  });

  it("next_action_at is set 15 days before expiry (renewal reminder window)", async () => {
    await provisionPendingHosting(pendingRow());
    const doc = mockHostingCreate.fn.mock.calls[0][0] as Record<string, unknown>;
    const expiry = (doc.expiryDate as Date).getTime();
    const nextAction = (doc.next_action_at as Date).getTime();
    const fifteenDaysMs = 15 * 24 * 60 * 60 * 1000;
    expect(expiry - nextAction).toBe(fifteenDaysMs);
  });
});
