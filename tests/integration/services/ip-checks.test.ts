/**
 * Service-layer integration tests for lib/services/ip-checks.ts.
 *
 * Two helpers: write the latest probe result, read the latest one back.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { clearAllCollections } from "../setup";
import IPCheck from "@/models/IPCheck";
import { getLatestIPCheck, recordIPCheck } from "@/lib/services/ip-checks";

beforeAll(async () => {
  expect(mongoose.connection.readyState).toBe(1);
  await IPCheck.syncIndexes();
});

beforeEach(clearAllCollections);

describe("recordIPCheck", () => {
  it("persists a probe result with checkedAt stamped server-side", async () => {
    const before = Date.now();
    const checkedBy = new mongoose.Types.ObjectId();
    const row = await recordIPCheck({
      success: true,
      message: "ok",
      data: {
        primaryIP: "1.2.3.4",
        allIPs: ["1.2.3.4"],
        timestamp: new Date().toISOString(),
        services: {},
      },
      checkedBy,
    });
    expect(row._id).toBeDefined();
    expect(row.success).toBe(true);
    expect(row.message).toBe("ok");
    expect(row.checkedBy.toString()).toBe(checkedBy.toString());
    expect(row.checkedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe("getLatestIPCheck", () => {
  it("returns the most-recently-checked row (sorted by checkedAt desc)", async () => {
    const userA = new mongoose.Types.ObjectId();
    const userB = new mongoose.Types.ObjectId();

    // Insert older row first, then a newer one.
    const older = await recordIPCheck({
      success: true,
      message: "older",
      checkedBy: userA,
    });
    // Backdate the older one so we can deterministically assert the order.
    await mongoose.connection.db?.collection("ipchecks").updateOne(
      { _id: older._id },
      { $set: { checkedAt: new Date(Date.now() - 60_000) } }
    );

    const newer = await recordIPCheck({
      success: false,
      message: "newer",
      error: "rate limited",
      checkedBy: userB,
    });

    const latest = await getLatestIPCheck();
    expect(latest?._id?.toString()).toBe(newer._id.toString());
    expect(latest?.message).toBe("newer");
  });

  it("returns null when no row exists", async () => {
    expect(await getLatestIPCheck()).toBeNull();
  });
});
