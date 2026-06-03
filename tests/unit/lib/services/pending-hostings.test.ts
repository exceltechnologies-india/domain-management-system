/**
 * Tests for `@/lib/services/pending-hostings` (rescan-4 slice 7fl).
 * PendingHosting service — companion to pending-domains for the
 * hosting-provision deferred/failed half-state. Pins:
 *  - **`status: 'pending'` rows are AUTO-RETRYABLE** (deferred — DA
 *    unreachable at checkout); **`'failed'` rows stay MANUAL** (DA
 *    rejected for a logical reason — admin must inspect)
 *  - listDeferredPendingHostings: caps at 50 rows + sorts createdAt
 *    ASC (oldest first — fair queue, no row stuck forever) + filters
 *    status:'pending' ONLY (not 'failed')
 *  - createPendingHosting default status:'failed' (legacy contract —
 *    callers explicitly opt into 'pending' for the deferred-retry flow)
 *  - deletePendingHostingsByUsername $or on BOTH legacy `username` AND
 *    `daUsername` fields (migration-window compat)
 *  - listStuckPendingHostings: cutoff-driven query with status $in
 *    [pending, failed] + slim projection for the alerting cron
 *  - **provisionPendingHosting 6-step retry flow**:
 *    1. User not found → `{ok:false, error:'User not found'}` — no
 *       state mutated, row stays for admin
 *    2. **user.directAdminUsername already set → DROP the row + return
 *       `dropped:true`** (sibling row already provisioned the user;
 *       keeping this row would block future sweeps with a misleading
 *       ALREADY_HAS_HOSTING error)
 *    3. DA createUser throw → pending.error stamped + pending.save +
 *       `{ok:false, error}` (admin will see latest reason on next view)
 *    4. **DNS update failure is best-effort** — logged + retry proceeds
 *    5. user.directAdminUsername / hostingCreatedAt / hostingExpiresAt
 *       all stamped; Hosting row created with next_action_at = expiry-15d
 *    6. PendingHosting deleted on success; provision email sent
 *       (failure SWALLOWED — the DA account is live + the user fields
 *       are set, missing email is a minor inconvenience)
 *  - Hosting.create throw is also SWALLOWED (DA account exists + user
 *    fields set — the local audit row can be reconciled later)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const connectDB = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

const PendingHosting = vi.hoisted(() => ({
  findById: vi.fn(),
  find: vi.fn(),
  countDocuments: vi.fn(),
  create: vi.fn(),
  findByIdAndDelete: vi.fn(),
  deleteMany: vi.fn(),
}));
vi.mock("@/models/PendingHosting", () => ({ default: PendingHosting }));

const getUserById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserById }));

const daCreateUser = vi.hoisted(() => vi.fn());
const daUpdateDNSNameservers = vi.hoisted(() => vi.fn());
vi.mock("@/lib/directadmin", () => ({
  DirectAdminService: {
    createUser: daCreateUser,
    updateDNSNameservers: daUpdateDNSNameservers,
    NAMESERVERS: ["ns1.test", "ns2.test"],
  },
  DA_SERVER_IP: "10.0.0.1",
}));

const sendHostingProvisionedEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  EmailService: { sendHostingProvisionedEmail },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const HostingCreate = vi.hoisted(() => vi.fn());
vi.mock("@/models/Hosting", () => ({
  default: { create: HostingCreate },
}));

import {
  getPendingHostingById,
  listPendingHostingsForAdmin,
  countPendingHostingsByStatus,
  listStuckPendingHostings,
  createPendingHosting,
  deletePendingHostingById,
  deletePendingHostingsByUsername,
  listDeferredPendingHostings,
  provisionPendingHosting,
} from "@/lib/services/pending-hostings";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("read helpers", () => {
  it("getPendingHostingById uses findById", async () => {
    PendingHosting.findById.mockResolvedValueOnce({ _id: "PH1" });
    await getPendingHostingById("PH1");
    expect(PendingHosting.findById).toHaveBeenCalledWith("PH1");
  });

  it("listPendingHostingsForAdmin populates user + sort newest-first", async () => {
    const sort = vi.fn().mockResolvedValueOnce([]);
    const populate = vi.fn().mockReturnValue({ sort });
    PendingHosting.find.mockReturnValueOnce({ populate });
    await listPendingHostingsForAdmin();
    expect(PendingHosting.find).toHaveBeenCalledWith({});
    expect(populate).toHaveBeenCalledWith("userId", "name email");
    expect(sort).toHaveBeenCalledWith({ createdAt: -1 });
  });

  it("countPendingHostingsByStatus delegates to countDocuments({status})", async () => {
    PendingHosting.countDocuments.mockResolvedValueOnce(7);
    expect(await countPendingHostingsByStatus("failed")).toBe(7);
    expect(PendingHosting.countDocuments).toHaveBeenCalledWith({ status: "failed" });
  });

  it("listStuckPendingHostings: cutoff-driven + status $in [pending, failed] + slim projection", async () => {
    const lean = vi.fn().mockResolvedValueOnce([]);
    const select = vi.fn().mockReturnValue({ lean });
    PendingHosting.find.mockReturnValueOnce({ select });
    const cutoff = new Date("2026-06-01");
    await listStuckPendingHostings(cutoff);
    const [filter] = PendingHosting.find.mock.calls[0];
    expect(filter.status.$in).toEqual(["pending", "failed"]);
    expect(filter.createdAt).toEqual({ $lt: cutoff });
    expect(select).toHaveBeenCalledWith("domain status createdAt error userId");
  });
});

describe("createPendingHosting — default status", () => {
  it("default status:'failed' (callers explicitly opt into 'pending')", async () => {
    PendingHosting.create.mockResolvedValueOnce({});
    await createPendingHosting({
      userId: "U1",
      domain: "x.com",
      package: "Starter",
      daUsername: "alice",
      error: "DA returned 503",
    });
    const [payload] = PendingHosting.create.mock.calls[0];
    expect(payload.status).toBe("failed");
  });

  it("explicit status:'pending' (auto-retry path) honored", async () => {
    PendingHosting.create.mockResolvedValueOnce({});
    await createPendingHosting({
      userId: "U1",
      domain: "x.com",
      package: "Starter",
      daUsername: "alice",
      error: "DA unreachable",
      status: "pending",
    });
    expect(PendingHosting.create.mock.calls[0][0].status).toBe("pending");
  });
});

describe("deletePendingHostingsByUsername — legacy + new field $or", () => {
  it("$or on `username` (legacy) AND `daUsername` (new) — migration-window compat", async () => {
    PendingHosting.deleteMany.mockResolvedValueOnce({ deletedCount: 2 });
    await deletePendingHostingsByUsername("alice");
    const [filter] = PendingHosting.deleteMany.mock.calls[0];
    expect(filter.$or).toEqual([
      { username: "alice" },
      { daUsername: "alice" },
    ]);
  });

  it("missing deletedCount → 0 (older driver compat)", async () => {
    PendingHosting.deleteMany.mockResolvedValueOnce({});
    expect(await deletePendingHostingsByUsername("alice")).toBe(0);
  });
});

describe("deletePendingHostingById", () => {
  it("uses findByIdAndDelete", async () => {
    PendingHosting.findByIdAndDelete.mockResolvedValueOnce({ _id: "PH1" });
    await deletePendingHostingById("PH1");
    expect(PendingHosting.findByIdAndDelete).toHaveBeenCalledWith("PH1");
  });
});

describe("listDeferredPendingHostings — auto-retry queue", () => {
  it("filters status:'pending' ONLY + sort createdAt ASC + cap 50", async () => {
    const limit = vi.fn().mockResolvedValueOnce([]);
    const sort = vi.fn().mockReturnValue({ limit });
    PendingHosting.find.mockReturnValueOnce({ sort });
    await listDeferredPendingHostings();
    expect(PendingHosting.find).toHaveBeenCalledWith({ status: "pending" });
    expect(sort).toHaveBeenCalledWith({ createdAt: 1 }); // ASC — oldest first
    expect(limit).toHaveBeenCalledWith(50);
  });
});

describe("provisionPendingHosting — 6-step retry flow", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const baseUser = (overrides: Record<string, unknown> = {}): any => ({
    _id: "U1",
    email: "u@x.test",
    firstName: "Alice",
    directAdminUsername: undefined as string | undefined,
    hostingCreatedAt: undefined,
    hostingExpiresAt: undefined,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function pendingDoc(overrides: Record<string, unknown> = {}): any {
    return {
      _id: "PH1",
      domain: "x.com",
      package: "Starter",
      daUsername: "alice12345",
      userId: "U1",
      error: "DA was unreachable",
      save: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it("step 1: user not found → {ok:false, error:'User not found'} (no mutation)", async () => {
    getUserById.mockResolvedValueOnce(null);
    const result = await provisionPendingHosting(pendingDoc());
    expect(result).toEqual({
      domain: "x.com",
      ok: false,
      error: "User not found",
    });
    expect(daCreateUser).not.toHaveBeenCalled();
  });

  it("step 2: user.directAdminUsername ALREADY SET → drop the row, return dropped:true", async () => {
    const user = baseUser({ directAdminUsername: "existing-username" });
    getUserById.mockResolvedValueOnce(user);
    PendingHosting.findByIdAndDelete.mockResolvedValueOnce({});
    const pending = pendingDoc();
    const result = await provisionPendingHosting(pending);
    expect(result).toEqual({ domain: "x.com", ok: true, dropped: true });
    // PendingHosting deleted — keeping it would block future sweeps
    expect(PendingHosting.findByIdAndDelete).toHaveBeenCalledWith("PH1");
    // No DA call, no further state changes
    expect(daCreateUser).not.toHaveBeenCalled();
  });

  it("step 3: daCreateUser throw → bumps pending.error + saves + {ok:false}", async () => {
    getUserById.mockResolvedValueOnce(baseUser());
    daCreateUser.mockRejectedValueOnce(new Error("DA still down"));
    const pending = pendingDoc();
    const result = await provisionPendingHosting(pending);
    expect(result).toEqual({
      domain: "x.com",
      ok: false,
      error: "DA still down",
    });
    expect(pending.error).toBe("DA still down");
    expect(pending.save).toHaveBeenCalled();
    expect(PendingHosting.findByIdAndDelete).not.toHaveBeenCalled();
  });

  it("step 4: DNS update FAILURE is best-effort (logged + retry proceeds to step 5)", async () => {
    const user = baseUser();
    getUserById.mockResolvedValueOnce(user);
    daCreateUser.mockResolvedValueOnce(undefined);
    daUpdateDNSNameservers.mockRejectedValueOnce(new Error("DNS push 503"));
    PendingHosting.findByIdAndDelete.mockResolvedValueOnce({});
    HostingCreate.mockResolvedValueOnce({});
    const result = await provisionPendingHosting(pendingDoc());
    // Retry succeeds despite DNS failure
    expect(result).toEqual({ domain: "x.com", ok: true });
    // User fields still stamped
    expect(user.directAdminUsername).toBe("alice12345");
  });

  it("step 5: user fields stamped + Hosting row created with next_action_at=expiry-15d", async () => {
    const user = baseUser();
    getUserById.mockResolvedValueOnce(user);
    daCreateUser.mockResolvedValueOnce(undefined);
    daUpdateDNSNameservers.mockResolvedValueOnce(undefined);
    PendingHosting.findByIdAndDelete.mockResolvedValueOnce({});
    HostingCreate.mockResolvedValueOnce({});
    sendHostingProvisionedEmail.mockResolvedValueOnce(undefined);
    await provisionPendingHosting(pendingDoc());
    // User stamped
    expect(user.directAdminUsername).toBe("alice12345");
    expect(user.hostingCreatedAt).toBeInstanceOf(Date);
    expect(user.hostingExpiresAt).toBeInstanceOf(Date);
    expect(user.save).toHaveBeenCalled();
    // Hosting row created
    expect(HostingCreate).toHaveBeenCalled();
    const [payload] = HostingCreate.mock.calls[0];
    expect(payload.domainName).toBe("x.com");
    expect(payload.directAdminUsername).toBe("alice12345");
    expect(payload.status).toBe("active");
    expect(payload.billingType).toBe("manual"); // retry path = manual billing
    expect(payload.isTrial).toBe(false);
    // next_action_at = expiry - 15 days
    expect(payload.next_action_at.getTime()).toBe(
      payload.expiryDate.getTime() - 15 * 24 * 60 * 60 * 1000
    );
  });

  it("step 5: Hosting.create throw is SWALLOWED (DA account live + user fields set — local audit reconciled later)", async () => {
    const user = baseUser();
    getUserById.mockResolvedValueOnce(user);
    daCreateUser.mockResolvedValueOnce(undefined);
    daUpdateDNSNameservers.mockResolvedValueOnce(undefined);
    PendingHosting.findByIdAndDelete.mockResolvedValueOnce({});
    HostingCreate.mockRejectedValueOnce(new Error("Hosting save failed"));
    sendHostingProvisionedEmail.mockResolvedValueOnce(undefined);
    const result = await provisionPendingHosting(pendingDoc());
    // Retry STILL succeeds — DA account is live + user has the credentials
    expect(result).toEqual({ domain: "x.com", ok: true });
  });

  it("step 6: PendingHosting deleted + provision email sent on success", async () => {
    const user = baseUser();
    getUserById.mockResolvedValueOnce(user);
    daCreateUser.mockResolvedValueOnce(undefined);
    daUpdateDNSNameservers.mockResolvedValueOnce(undefined);
    PendingHosting.findByIdAndDelete.mockResolvedValueOnce({});
    HostingCreate.mockResolvedValueOnce({});
    sendHostingProvisionedEmail.mockResolvedValueOnce(undefined);
    await provisionPendingHosting(pendingDoc({ _id: "PH_DROP" }));
    expect(PendingHosting.findByIdAndDelete).toHaveBeenCalledWith("PH_DROP");
    expect(sendHostingProvisionedEmail).toHaveBeenCalled();
    const [, , details] = sendHostingProvisionedEmail.mock.calls[0];
    expect(details.domainName).toBe("x.com");
    expect(details.packageName).toBe("Starter");
    expect(details.serverIp).toBe("10.0.0.1");
    expect(details.nameservers).toEqual(["ns1.test", "ns2.test"]);
  });

  it("step 6: email failure SWALLOWED (DA account is live — missing email is minor inconvenience)", async () => {
    getUserById.mockResolvedValueOnce(baseUser());
    daCreateUser.mockResolvedValueOnce(undefined);
    daUpdateDNSNameservers.mockResolvedValueOnce(undefined);
    PendingHosting.findByIdAndDelete.mockResolvedValueOnce({});
    HostingCreate.mockResolvedValueOnce({});
    sendHostingProvisionedEmail.mockRejectedValueOnce(new Error("SMTP down"));
    const result = await provisionPendingHosting(pendingDoc());
    expect(result.ok).toBe(true);
  });
});
