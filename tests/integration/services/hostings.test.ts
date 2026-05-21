/**
 * Service-layer integration tests for lib/services/hostings.ts.
 *
 * Covers every helper added or extended during the H1 Hosting migration:
 * the user-scoped lookups, the lifecycle helpers used by the cron
 * (expiry / scheduler), the admin batch operations, and the DA-stats
 * upsert path.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { clearAllCollections } from "../setup";
import Hosting from "@/models/Hosting";
import {
  createHosting,
  deleteHostingsByIdOrUsername,
  findUserHosting,
  findUserHostingById,
  getHostingById,
  listAllHostingsForDirectAdminDiag,
  listDueServiceHostingCandidates,
  listExpiredActiveHostings,
  listHostingsByDirectAdminUsername,
  listHostingsForUser,
  listUserHostingsByDomain,
  lockHostingForScheduler,
  releaseHostingSchedulerLock,
  touchHostingsLastSyncedForUser,
  upsertHostingFromDirectAdminStats,
  userHasAnyHosting,
} from "@/lib/services/hostings";

const validUserId = () => new mongoose.Types.ObjectId();

function buildHostingPayload(overrides: Record<string, unknown> = {}) {
  const tag = Math.random().toString(36).slice(2, 8);
  return {
    userId: validUserId(),
    domainName: `${tag}.test`,
    planId: "starter",
    name: "Starter",
    serverPackage: "Starter",
    status: "active",
    startDate: new Date(),
    expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    orderId: `ord_${tag}`,
    ...overrides,
  };
}

beforeAll(async () => {
  expect(mongoose.connection.readyState).toBe(1);
  // Build the schema-declared indexes (incl. the unique sparse index on
  // (userId, domainName)) so duplicate-key tests trip them.
  await Hosting.syncIndexes();
});

beforeEach(clearAllCollections);

describe("createHosting / getHostingById", () => {
  it("inserts a hosting and reads it back by _id", async () => {
    const created = await createHosting(buildHostingPayload({ orderId: "ord_h_1" }));
    const fetched = await getHostingById(String(created._id));
    expect(fetched?.orderId).toBe("ord_h_1");
  });

  it("returns the lean form when options.lean is set", async () => {
    const created = await createHosting(buildHostingPayload({ orderId: "ord_h_lean" }));
    const lean = await getHostingById(String(created._id), { lean: true });
    // Lean docs lack Mongoose Document methods like .save().
    expect(lean).toBeTruthy();
    expect((lean as unknown as { save?: unknown }).save).toBeUndefined();
  });
});

describe("findUserHosting", () => {
  it("scopes by userId and optionally narrows by domainName", async () => {
    const owner = validUserId();
    await createHosting(
      buildHostingPayload({ userId: owner, domainName: "a.test" })
    );
    await createHosting(
      buildHostingPayload({ userId: owner, domainName: "b.test" })
    );
    await createHosting(
      buildHostingPayload({ userId: validUserId(), domainName: "a.test" })
    );

    // With domainName: returns only this user's row for that domain.
    const scoped = await findUserHosting(String(owner), { domainName: "a.test" });
    expect(scoped?.domainName).toBe("a.test");
    expect(scoped?.userId.toString()).toBe(owner.toString());

    // Without domainName: returns any row for the user.
    const any = await findUserHosting(String(owner));
    expect(any?.userId.toString()).toBe(owner.toString());
  });
});

describe("findUserHostingById", () => {
  it("enforces ownership — returns null when the id belongs to another user", async () => {
    const owner = validUserId();
    const intruder = validUserId();
    const h = await createHosting(buildHostingPayload({ userId: owner }));

    expect((await findUserHostingById(String(h._id), owner))?.userId.toString())
      .toBe(owner.toString());
    expect(await findUserHostingById(String(h._id), intruder)).toBeNull();
  });
});

describe("userHasAnyHosting", () => {
  it("returns true if any hosting row exists for the user", async () => {
    const userId = validUserId();
    expect(await userHasAnyHosting(String(userId))).toBe(false);
    await createHosting(buildHostingPayload({ userId }));
    expect(await userHasAnyHosting(String(userId))).toBe(true);
  });
});

describe("listHostingsForUser", () => {
  it("returns newest-first and respects limit:0 as unbounded", async () => {
    const userId = validUserId();
    for (let i = 0; i < 55; i++) {
      await createHosting(buildHostingPayload({ userId, domainName: `b${i}.test` }));
    }
    const capped = await listHostingsForUser(userId);
    expect(capped.length).toBe(50);

    const all = await listHostingsForUser(userId, { limit: 0 });
    expect(all.length).toBe(55);
  });
});

describe("listUserHostingsByDomain", () => {
  it("returns the row for (userId, domainName) and excludes other users' rows", async () => {
    // Note: there's a unique sparse index on (userId, domainName) so only
    // one row can exist per pair. The helper is shaped as a list because the
    // callsite walks results to dedup by DA username, but in practice it
    // returns 0-1 rows.
    const owner = validUserId();
    const other = validUserId();
    const mine = await createHosting(
      buildHostingPayload({ userId: owner, domainName: "shared.test" })
    );
    await createHosting(
      buildHostingPayload({ userId: other, domainName: "shared.test" })
    );

    const rows = await listUserHostingsByDomain(owner, "shared.test");
    expect(rows.length).toBe(1);
    expect(rows[0]._id.toString()).toBe(mine._id.toString());
  });
});

describe("touchHostingsLastSyncedForUser", () => {
  it("stamps lastSyncedAt on every hosting the user owns", async () => {
    const owner = validUserId();
    const other = validUserId();
    await createHosting(buildHostingPayload({ userId: owner, domainName: "x.test" }));
    await createHosting(buildHostingPayload({ userId: owner, domainName: "y.test" }));
    await createHosting(buildHostingPayload({ userId: other, domainName: "z.test" }));

    const before = Date.now();
    await touchHostingsLastSyncedForUser(owner);

    const mine = await Hosting.find({ userId: owner });
    for (const h of mine) {
      expect(h.lastSyncedAt).toBeDefined();
      expect(h.lastSyncedAt!.getTime()).toBeGreaterThanOrEqual(before);
    }
    const otherRow = await Hosting.findOne({ userId: other });
    expect(otherRow?.lastSyncedAt).toBeUndefined();
  });
});

describe("upsertHostingFromDirectAdminStats", () => {
  it("inserts a new row when the filter matches nothing", async () => {
    const userId = validUserId();
    await upsertHostingFromDirectAdminStats({
      filter: { userId, domainName: "upsert.test" },
      set: { status: "active", directAdminUsername: "daU1" },
      setOnInsert: {
        userId,
        domainName: "upsert.test",
        orderId: "IMPORTED-daU1",
        name: "Imported",
        serverPackage: "default",
        planId: "default",
        startDate: new Date(),
        expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        autoRenew: false,
      },
    });
    const row = await Hosting.findOne({ userId, domainName: "upsert.test" });
    expect(row?.directAdminUsername).toBe("daU1");
    expect(row?.orderId).toBe("IMPORTED-daU1");
  });

  it("updates an existing row without running $setOnInsert defaults", async () => {
    const userId = validUserId();
    const h = await createHosting(
      buildHostingPayload({ userId, domainName: "exist.test", planId: "starter" })
    );

    // Mongo rejects updates where $set and $setOnInsert touch the same path,
    // so the helper's callers (stats/sync) make the two clauses disjoint —
    // this test exercises that contract.
    await upsertHostingFromDirectAdminStats({
      filter: { _id: h._id },
      set: { status: "active", planId: "plus" },
      setOnInsert: {
        userId,
        domainName: "exist.test",
        orderId: "DO-NOT-OVERWRITE",
        name: "n",
        serverPackage: "p",
        startDate: new Date(),
        expiryDate: new Date(),
        autoRenew: false,
      },
    });

    const after = await Hosting.findById(h._id);
    expect(after?.planId).toBe("plus"); // $set applied
    expect(after?.orderId).toBe(h.orderId); // $setOnInsert did NOT run
  });
});

describe("listExpiredActiveHostings (cron)", () => {
  it("returns only active rows whose expiryDate is past the cutoff", async () => {
    const userId = validUserId();
    await createHosting(
      buildHostingPayload({
        userId,
        domainName: "exp.test",
        status: "active",
        expiryDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
      })
    );
    await createHosting(
      buildHostingPayload({
        userId,
        domainName: "future.test",
        status: "active",
        expiryDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      })
    );
    await createHosting(
      buildHostingPayload({
        userId,
        domainName: "expired-but-terminated.test",
        status: "terminated",
        expiryDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
      })
    );

    const list = await listExpiredActiveHostings(new Date());
    expect(list.map((h) => h.domainName)).toEqual(["exp.test"]);
  });
});

describe("listDueServiceHostingCandidates + scheduler lock lifecycle", () => {
  it("returns only due+unlocked candidates and excludes terminal statuses", async () => {
    const userId = validUserId();
    const now = new Date();

    // Due and unlocked → expect.
    const due = await createHosting(
      buildHostingPayload({
        userId, domainName: "due.test", status: "active",
        next_action_at: new Date(now.getTime() - 60_000),
      })
    );
    // Due but locked far in the future → exclude.
    await createHosting(
      buildHostingPayload({
        userId, domainName: "locked.test", status: "active",
        next_action_at: new Date(now.getTime() - 60_000),
        processing_until: new Date(now.getTime() + 60 * 60_000),
      })
    );
    // Due but terminal status → exclude.
    await createHosting(
      buildHostingPayload({
        userId, domainName: "terminated.test", status: "terminated",
        next_action_at: new Date(now.getTime() - 60_000),
      })
    );
    // Not yet due → exclude.
    await createHosting(
      buildHostingPayload({
        userId, domainName: "future.test", status: "active",
        next_action_at: new Date(now.getTime() + 60 * 60_000),
      })
    );

    const list = await listDueServiceHostingCandidates({ now, batchSize: 100 });
    expect(list.map((h) => h._id.toString())).toEqual([due._id.toString()]);
  });

  it("lockHostingForScheduler acquires once and rejects concurrent attempts", async () => {
    const h = await createHosting(buildHostingPayload({ status: "active" }));
    const now = new Date();
    const lockExpiry = new Date(now.getTime() + 10 * 60_000);

    const first = await lockHostingForScheduler({ hostingId: h._id, now, lockExpiry });
    expect(first).toBeTruthy();

    const second = await lockHostingForScheduler({ hostingId: h._id, now, lockExpiry });
    expect(second).toBeNull();
  });

  it("releaseHostingSchedulerLock only clears matching lockExpiry (concurrent-safe)", async () => {
    const h = await createHosting(buildHostingPayload({ status: "active" }));
    const now = new Date();
    const myLockExpiry = new Date(now.getTime() + 10 * 60_000);
    await lockHostingForScheduler({ hostingId: h._id, now, lockExpiry: myLockExpiry });

    // Wrong expiry value — must be a no-op (preserves the existing lock).
    await releaseHostingSchedulerLock({
      hostingId: h._id,
      lockExpiry: new Date(now.getTime() + 999_999),
    });
    const stillLocked = await Hosting.findById(h._id);
    expect(stillLocked?.processing_until?.toISOString()).toBe(myLockExpiry.toISOString());

    // Correct expiry — clears the lock.
    await releaseHostingSchedulerLock({ hostingId: h._id, lockExpiry: myLockExpiry });
    const cleared = await Hosting.findById(h._id);
    expect(cleared?.processing_until).toBeNull();
  });
});

describe("listAllHostingsForDirectAdminDiag", () => {
  it("returns every row with the DA-cross-reference projection", async () => {
    await createHosting(
      buildHostingPayload({ domainName: "diag-a.test", directAdminUsername: "daA" })
    );
    await createHosting(
      buildHostingPayload({ domainName: "diag-b.test", directAdminUsername: "daB" })
    );
    const all = await listAllHostingsForDirectAdminDiag();
    expect(all.length).toBe(2);
    expect(all.map((h) => h.directAdminUsername).sort()).toEqual(["daA", "daB"]);
  });
});

describe("listHostingsByDirectAdminUsername + deleteHostingsByIdOrUsername", () => {
  it("lists every hosting tied to a DA username", async () => {
    await createHosting(
      buildHostingPayload({ domainName: "z1.test", directAdminUsername: "shared" })
    );
    await createHosting(
      buildHostingPayload({ domainName: "z2.test", directAdminUsername: "shared" })
    );
    await createHosting(
      buildHostingPayload({ domainName: "z3.test", directAdminUsername: "other" })
    );
    const list = await listHostingsByDirectAdminUsername("shared");
    expect(list.length).toBe(2);
  });

  it("deletes by hostingId and returns the matched snapshot", async () => {
    const h = await createHosting(buildHostingPayload({ directAdminUsername: "delU" }));
    const { deletedCount, matchedHostings } = await deleteHostingsByIdOrUsername({
      hostingId: String(h._id),
    });
    expect(deletedCount).toBe(1);
    expect(matchedHostings[0]._id.toString()).toBe(h._id.toString());
    expect(await Hosting.findById(h._id)).toBeNull();
  });

  it("deletes by DA username matches every linked row", async () => {
    await createHosting(buildHostingPayload({ directAdminUsername: "manyU", domainName: "p1.test" }));
    await createHosting(buildHostingPayload({ directAdminUsername: "manyU", domainName: "p2.test" }));
    const { deletedCount } = await deleteHostingsByIdOrUsername({ directAdminUsername: "manyU" });
    expect(deletedCount).toBe(2);
  });
});
