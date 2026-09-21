/**
 * The idempotency store and the subject mutex.
 *
 * WHAT THESE TESTS DO NOT PROVE: that the unique indexes work. That is a
 * property of MongoDB, not of this code, and mocking the driver would only
 * assert that the mock returns what the mock was told to. It was verified
 * against the real database instead, in a throwaway db:
 *
 *   two `domain.register` claims on example.com  -> second BLOCKED (11000)
 *   `dns.edit` on the same domain                -> ACQUIRED (different verb)
 *   `domain.register` on another domain          -> ACQUIRED
 *   delete by a non-holder                       -> deletedCount 0
 *   the same claim keyed on commandId instead    -> BOTH allowed, collision invisible
 *
 * What IS worth pinning here is the logic wrapped around those indexes, which
 * is where the decisions live.
 *
 * Threat model:
 *  - **`needs_reconciliation` must NOT release the claim.** The provider may
 *    have completed the work (`sent_unknown` from Phase 1), so freeing the
 *    subject would let the next attempt register the same domain twice. This
 *    is the single most expensive line in the file.
 *  - **A release must be owner-scoped.** A command that stalled past its TTL
 *    must not come back and free a claim someone else has since taken.
 *  - **Insert-or-fail, never read-then-write.** Two copies of a retry that
 *    both read "new" would both proceed — the bug the store exists to stop,
 *    reintroduced inside its own implementation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const commandCreate = vi.hoisted(() => vi.fn());
const commandFindOne = vi.hoisted(() => vi.fn());
const commandFindOneAndUpdate = vi.hoisted(() => vi.fn());
const commandUpdateOne = vi.hoisted(() => vi.fn());
const commandFind = vi.hoisted(() => vi.fn());
vi.mock("@/models/EngineCommand", () => ({
  default: {
    create: commandCreate,
    findOne: commandFindOne,
    findOneAndUpdate: commandFindOneAndUpdate,
    updateOne: commandUpdateOne,
    find: commandFind,
  },
}));

const claimCreate = vi.hoisted(() => vi.fn());
const claimFindOne = vi.hoisted(() => vi.fn());
const claimDeleteOne = vi.hoisted(() => vi.fn());
vi.mock("@/models/EngineSubjectClaim", () => ({
  default: { create: claimCreate, findOne: claimFindOne, deleteOne: claimDeleteOne },
}));

vi.mock("@/lib/mongodb", () => ({ default: vi.fn(async () => {}) }));
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  settleCommand,
  decideStuckCommand,
  acquireSubjectClaim,
  releaseSubjectClaim,
  startCommand,
  completeCommand,
  releaseAfterReconciliation,
  DEFAULT_CLAIM_TTL_MS,
} from "@/lib/services/engine-commands";

const dupKey = () => Object.assign(new Error("E11000 duplicate key"), { code: 11000 });

beforeEach(() => {
  commandCreate.mockReset();
  commandFindOne.mockReset();
  commandFindOneAndUpdate.mockReset();
  commandUpdateOne.mockReset().mockResolvedValue({});
  claimCreate.mockReset();
  claimFindOne.mockReset();
  claimDeleteOne.mockReset().mockResolvedValue({ deletedCount: 1 });
  commandFind.mockReset();
});

describe("acquireSubjectClaim", () => {
  it("inserts — it does not read first", async () => {
    claimCreate.mockResolvedValueOnce({});
    const r = await acquireSubjectClaim("domain.register", "example.com", "cmd-1");
    expect(r).toEqual({ ok: true });
    // A findOne before the insert is the read-then-write race.
    expect(claimFindOne).not.toHaveBeenCalled();
  });

  it("a duplicate key means held, and names the holder", async () => {
    claimCreate.mockRejectedValueOnce(dupKey());
    const expiresAt = new Date(Date.now() + 60_000);
    claimFindOne.mockReturnValueOnce({
      lean: async () => ({ commandId: "cmd-other", expiresAt }),
    });
    const r = await acquireSubjectClaim("domain.register", "example.com", "cmd-2");
    expect(r).toEqual({ ok: false, reason: "held", heldBy: "cmd-other", expiresAt });
  });

  it("a non-duplicate error propagates — it is not swallowed as 'held'", async () => {
    // Reporting a connection failure as "someone else has it" would send an
    // operator looking for a command that does not exist.
    claimCreate.mockRejectedValueOnce(Object.assign(new Error("no primary"), { code: 91 }));
    await expect(acquireSubjectClaim("domain.register", "x.com", "cmd-3")).rejects.toThrow(
      /no primary/
    );
  });

  it("an expired-but-unswept claim still reports held", async () => {
    // Mongo's TTL monitor runs ~once a minute, so the row can outlive
    // expiresAt. The unique key is still there, so the honest answer is held.
    claimCreate.mockRejectedValueOnce(dupKey());
    const expiresAt = new Date(Date.now() - 30_000);
    claimFindOne.mockReturnValueOnce({ lean: async () => ({ commandId: "cmd-dead", expiresAt }) });
    const r = await acquireSubjectClaim("domain.register", "example.com", "cmd-4");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.heldBy).toBe("cmd-dead");
  });

  it("uses a TTL long enough for a slow registrar call", async () => {
    // Too short risks two concurrent registrations; too long risks a support
    // ticket. The asymmetry is why this errs long.
    expect(DEFAULT_CLAIM_TTL_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
    claimCreate.mockResolvedValueOnce({});
    await acquireSubjectClaim("domain.register", "a.com", "cmd-5");
    const arg = claimCreate.mock.calls[0][0];
    expect(arg.expiresAt.getTime()).toBeGreaterThan(Date.now() + 4 * 60 * 1000);
  });
});

describe("releaseSubjectClaim — owner-scoped", () => {
  it("filters on commandId, so a stalled command cannot free someone else's claim", async () => {
    await releaseSubjectClaim("domain.register", "example.com", "cmd-1");
    expect(claimDeleteOne).toHaveBeenCalledWith({
      command: "domain.register",
      subject: "example.com",
      commandId: "cmd-1",
    });
  });

  it("reports false when it deleted nothing", async () => {
    claimDeleteOne.mockResolvedValueOnce({ deletedCount: 0 });
    await expect(releaseSubjectClaim("domain.register", "x.com", "cmd-9")).resolves.toBe(false);
  });
});

describe("startCommand", () => {
  it("inserts first — a findOne-then-create would let two retries both proceed", async () => {
    commandCreate.mockResolvedValueOnce({ commandId: "cmd-1" });
    const r = await startCommand({ commandId: "cmd-1", command: "domain.register", subject: "a.com" });
    expect(r.ok).toBe(true);
    expect(commandFindOne).not.toHaveBeenCalled();
  });

  it("a duplicate returns the STORED command, so a replay can be answered", async () => {
    commandCreate.mockRejectedValueOnce(dupKey());
    const stored = { commandId: "cmd-1", status: "succeeded", result: { orderId: "RC-1" } };
    commandFindOne.mockResolvedValueOnce(stored);
    const r = await startCommand({ commandId: "cmd-1", command: "domain.register", subject: "a.com" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("duplicate");
      expect(r.command).toBe(stored);
    }
  });
});

describe("completeCommand — the claim is released, except when it must not be", () => {
  const doc = (over = {}) => ({
    commandId: "cmd-1",
    command: "domain.register",
    subject: "example.com",
    ...over,
  });

  it.each(["succeeded", "failed"] as const)("%s releases the claim", async (status) => {
    commandFindOneAndUpdate.mockResolvedValueOnce(doc());
    await completeCommand({ commandId: "cmd-1", status });
    expect(claimDeleteOne).toHaveBeenCalledWith({
      command: "domain.register",
      subject: "example.com",
      commandId: "cmd-1",
    });
  });

  it("needs_reconciliation HOLDS the claim — this is the expensive one", async () => {
    // The provider may already have registered the domain (sent_unknown).
    // Releasing would let the next attempt register it a second time, and
    // that money does not come back.
    commandFindOneAndUpdate.mockResolvedValueOnce(doc());
    await completeCommand({
      commandId: "cmd-1",
      status: "needs_reconciliation",
      transport: "sent_unknown",
    });
    expect(claimDeleteOne).not.toHaveBeenCalled();
  });

  it("records the transport, so why it is unresolved survives", async () => {
    commandFindOneAndUpdate.mockResolvedValueOnce(doc());
    await completeCommand({ commandId: "cmd-1", status: "needs_reconciliation", transport: "sent_unknown" });
    const update = commandFindOneAndUpdate.mock.calls[0][1].$set;
    expect(update.transport).toBe("sent_unknown");
    expect(update.status).toBe("needs_reconciliation");
  });

  it("an unknown commandId returns null rather than releasing something", async () => {
    commandFindOneAndUpdate.mockResolvedValueOnce(null);
    await expect(completeCommand({ commandId: "nope", status: "succeeded" })).resolves.toBeNull();
    expect(claimDeleteOne).not.toHaveBeenCalled();
  });
});

describe("releaseAfterReconciliation", () => {
  it("is the only way to free a held claim, and is separate on purpose", async () => {
    // Folding this into completeCommand would mean the code that could not
    // tell whether the work happened is also the code that frees the lock.
    commandFindOne.mockResolvedValueOnce({
      commandId: "cmd-1",
      command: "domain.register",
      subject: "example.com",
    });
    await expect(releaseAfterReconciliation("cmd-1")).resolves.toBe(true);
    expect(claimDeleteOne).toHaveBeenCalledWith({
      command: "domain.register",
      subject: "example.com",
      commandId: "cmd-1",
    });
  });

  it("unknown commandId → false, nothing deleted", async () => {
    commandFindOne.mockResolvedValueOnce(null);
    await expect(releaseAfterReconciliation("nope")).resolves.toBe(false);
    expect(claimDeleteOne).not.toHaveBeenCalled();
  });
});


// ─── Recovery ────────────────────────────────────────────────────────────────

describe("settleCommand — only acts on a definite answer", () => {
  const stuck = {
    commandId: "cmd-1",
    command: "domain.register",
    subject: "example.com",
    status: "needs_reconciliation",
    request: {},
  };

  it("refuses a command that is not stuck", async () => {
    // A settled command has already released its claim. Reconciling it again
    // would ask the provider about finished work, and an ambiguous answer
    // could reopen it.
    commandFindOne.mockResolvedValueOnce({ ...stuck, status: "succeeded" });
    const r = await settleCommand("cmd-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_stuck");
    expect(claimDeleteOne).not.toHaveBeenCalled();
  });

  it("refuses an unknown commandId", async () => {
    commandFindOne.mockResolvedValueOnce(null);
    const r = await settleCommand("nope");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
  });

  it("no reconciler → NOT settled, and the claim stays held", async () => {
    // This is the important one: with no way to check, the subject must stay
    // locked. Releasing it here is how the same domain gets registered twice.
    commandFindOne.mockResolvedValueOnce(stuck);
    const r = await settleCommand("cmd-1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.settled).toBe(false);
    expect(claimDeleteOne).not.toHaveBeenCalled();
    expect(commandUpdateOne).not.toHaveBeenCalled();
  });
});

describe("decideStuckCommand — a human settles what the machine could not", () => {
  const stuck = {
    commandId: "cmd-1",
    command: "domain.register",
    subject: "example.com",
    status: "needs_reconciliation",
  };

  it("resolve → succeeded, and frees the subject", async () => {
    commandFindOne.mockResolvedValueOnce(stuck);
    const r = await decideStuckCommand({
      commandId: "cmd-1", decision: "resolve", who: "pardeep", why: "domain is live in RC",
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.settled) expect(r.status).toBe("succeeded");
    expect(claimDeleteOne).toHaveBeenCalledWith({
      command: "domain.register", subject: "example.com", commandId: "cmd-1",
    });
  });

  it("requeue → failed, frees the subject, and does NOT retry", async () => {
    commandFindOne.mockResolvedValueOnce(stuck);
    const r = await decideStuckCommand({
      commandId: "cmd-1", decision: "requeue", who: "pardeep", why: "not in RC",
    });
    if (r.ok && r.settled) expect(r.status).toBe("failed");
    // Nothing re-runs. An automatic retry would re-do work a human has just
    // had to establish by hand — and if they were wrong, it is the second one.
    expect(r.ok && r.settled && r.detail).toMatch(/send a NEW commandId/i);
  });

  it("records who and why on the row", async () => {
    commandFindOne.mockResolvedValueOnce(stuck);
    await decideStuckCommand({
      commandId: "cmd-1", decision: "resolve", who: "pardeep", why: "checked the console",
    });
    const note = commandUpdateOne.mock.calls[0][1].$set.note as string;
    expect(note).toContain("pardeep");
    expect(note).toContain("checked the console");
  });

  it("refuses a command that is not stuck", async () => {
    commandFindOne.mockResolvedValueOnce({ ...stuck, status: "failed" });
    const r = await decideStuckCommand({
      commandId: "cmd-1", decision: "resolve", who: "x", why: "y",
    });
    expect(r.ok).toBe(false);
    expect(claimDeleteOne).not.toHaveBeenCalled();
  });
});
