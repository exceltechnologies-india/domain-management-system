/**
 * Service-layer integration tests for lib/services/domain-watches.ts.
 *
 * Covers both user CRUD and the cron-side batch + lifecycle:
 *   list / count / upsert / remove (user)
 *   listWatchesForCron / recordWatchCheck / removeWatchById (cron)
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { clearAllCollections } from "../setup";
import DomainWatch from "@/models/DomainWatch";
import User from "@/models/User";
import {
  countWatchesForUser,
  listWatchesForCron,
  listWatchesForUser,
  recordWatchCheck,
  removeUserWatch,
  removeWatchById,
  upsertUserWatch,
} from "@/lib/services/domain-watches";

const validUserId = () => new mongoose.Types.ObjectId();

beforeAll(async () => {
  expect(mongoose.connection.readyState).toBe(1);
  await DomainWatch.syncIndexes();
});

beforeEach(clearAllCollections);

describe("upsertUserWatch", () => {
  it("inserts a new watch on first call", async () => {
    const userId = validUserId();
    const w = await upsertUserWatch(String(userId), "alpha.test");
    expect(w._id).toBeDefined();
    expect(w.domainName).toBe("alpha.test");
    expect(w.userId.toString()).toBe(userId.toString());
  });

  it("is idempotent for the same (userId, domainName)", async () => {
    const userId = validUserId();
    const first = await upsertUserWatch(String(userId), "beta.test");
    const second = await upsertUserWatch(String(userId), "beta.test");
    expect(second._id.toString()).toBe(first._id.toString());
    expect(await countWatchesForUser(String(userId))).toBe(1);
  });
});

describe("listWatchesForUser + countWatchesForUser", () => {
  it("scopes results by userId, newest first", async () => {
    const owner = validUserId();
    const other = validUserId();
    await upsertUserWatch(String(owner), "a.test");
    await new Promise((r) => setTimeout(r, 5));
    await upsertUserWatch(String(owner), "b.test");
    await upsertUserWatch(String(other), "c.test");

    const list = await listWatchesForUser(String(owner));
    expect(list.map((w) => w.domainName)).toEqual(["b.test", "a.test"]);
    expect(await countWatchesForUser(String(owner))).toBe(2);
    expect(await countWatchesForUser(String(other))).toBe(1);
  });
});

describe("removeUserWatch", () => {
  it("returns true when a matching row is deleted", async () => {
    const userId = validUserId();
    await upsertUserWatch(String(userId), "deleteme.test");
    expect(await removeUserWatch(String(userId), "deleteme.test")).toBe(true);
    expect(await countWatchesForUser(String(userId))).toBe(0);
  });

  it("returns false when no row matches", async () => {
    expect(await removeUserWatch(String(validUserId()), "missing.test")).toBe(false);
  });
});

describe("listWatchesForCron + recordWatchCheck + removeWatchById", () => {
  it("returns lean watches with userId populated to the contact projection", async () => {
    // Insert a real User row so populate hydrates the contact fields.
    const u = await User.create({
      email: "watcher@test.local",
      password: "Sup3rS3cret!",
      firstName: "Watch",
      lastName: "User",
    });
    await upsertUserWatch(String(u._id), "cron.test");

    const cronRows = await listWatchesForCron(10);
    expect(cronRows.length).toBe(1);
    const populated = cronRows[0].userId as { email?: string; firstName?: string };
    expect(populated.email).toBe("watcher@test.local");
    expect(populated.firstName).toBe("Watch");
  });

  it("recordWatchCheck stamps lastCheckedAt + lastStatus", async () => {
    const userId = validUserId();
    const w = await upsertUserWatch(String(userId), "stamp.test");
    const before = Date.now();
    await recordWatchCheck(String(w._id), "available");
    const refetched = await DomainWatch.findById(w._id);
    expect(refetched?.lastStatus).toBe("available");
    expect(refetched?.lastCheckedAt?.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("removeWatchById deletes the row", async () => {
    const userId = validUserId();
    const w = await upsertUserWatch(String(userId), "byebye.test");
    await removeWatchById(String(w._id));
    expect(await DomainWatch.findById(w._id)).toBeNull();
  });
});
