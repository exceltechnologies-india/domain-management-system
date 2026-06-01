/**
 * Tests for `@/lib/services/domain-watches` (rescan-4 slice 7dx).
 * DomainWatch user-CRUD + cron-worker helpers. Pins:
 *  - listWatchesForUser: lean projection + sort createdAt:-1
 *  - countWatchesForUser: countDocuments({userId}) (cheap pre-check
 *    before upsert for the MAX_WATCHES limit)
 *  - upsertUserWatch: findOneAndUpdate with upsert+new+setDefaultsOnInsert,
 *    insert default lastStatus='unknown'
 *  - removeUserWatch: deleteOne returns deletedCount → bool (true on
 *    delete, false on miss so route maps to 404)
 *  - listWatchesForCron: populate userId with email/firstName/lastName
 *    + limit + lean
 *  - recordWatchCheck: $set lastCheckedAt+lastStatus
 *  - removeWatchById: deleteOne({_id})
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const connectDBMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDBMock }));

const findMock = vi.hoisted(() => vi.fn());
const countDocumentsMock = vi.hoisted(() => vi.fn());
const findOneAndUpdateMock = vi.hoisted(() => vi.fn());
const deleteOneMock = vi.hoisted(() => vi.fn());
const updateOneMock = vi.hoisted(() => vi.fn());
vi.mock("@/models/DomainWatch", () => ({
  default: {
    find: findMock,
    countDocuments: countDocumentsMock,
    findOneAndUpdate: findOneAndUpdateMock,
    deleteOne: deleteOneMock,
    updateOne: updateOneMock,
  },
}));

import {
  listWatchesForUser,
  countWatchesForUser,
  upsertUserWatch,
  removeUserWatch,
  listWatchesForCron,
  recordWatchCheck,
  removeWatchById,
} from "@/lib/services/domain-watches";

beforeEach(() => {
  connectDBMock.mockReset();
  findMock.mockReset();
  countDocumentsMock.mockReset();
  findOneAndUpdateMock.mockReset();
  deleteOneMock.mockReset();
  updateOneMock.mockReset();
});

describe("listWatchesForUser", () => {
  it("filters by userId, selects the dashboard-projection fields, sorts createdAt:-1 + lean", async () => {
    const leanMock = vi.fn().mockResolvedValue([{ _id: "w1", domainName: "x.com" }]);
    const sortMock = vi.fn().mockReturnValue({ lean: leanMock });
    const selectMock = vi.fn().mockReturnValue({ sort: sortMock });
    findMock.mockReturnValue({ select: selectMock });
    const result = await listWatchesForUser("user-1");
    expect(findMock).toHaveBeenCalledWith({ userId: "user-1" });
    expect(selectMock).toHaveBeenCalledWith(
      "domainName lastCheckedAt lastStatus notifiedAt createdAt"
    );
    expect(sortMock).toHaveBeenCalledWith({ createdAt: -1 });
    expect(leanMock).toHaveBeenCalled();
    expect(result).toEqual([{ _id: "w1", domainName: "x.com" }]);
  });
});

describe("countWatchesForUser", () => {
  it("delegates to countDocuments({userId})", async () => {
    countDocumentsMock.mockResolvedValueOnce(7);
    expect(await countWatchesForUser("user-1")).toBe(7);
    expect(countDocumentsMock).toHaveBeenCalledWith({ userId: "user-1" });
  });
});

describe("upsertUserWatch", () => {
  it("findOneAndUpdate with upsert + new + setDefaultsOnInsert + insert defaults lastStatus='unknown'", async () => {
    findOneAndUpdateMock.mockResolvedValueOnce({ _id: "w", domainName: "x.com" });
    await upsertUserWatch("user-1", "x.com");
    const [filter, update, opts] = findOneAndUpdateMock.mock.calls[0];
    expect(filter).toEqual({ userId: "user-1", domainName: "x.com" });
    expect(update).toEqual({
      userId: "user-1",
      domainName: "x.com",
      lastStatus: "unknown",
    });
    expect(opts).toEqual({ upsert: true, new: true, setDefaultsOnInsert: true });
  });
});

describe("removeUserWatch", () => {
  it("returns true when a row was deleted", async () => {
    deleteOneMock.mockResolvedValueOnce({ deletedCount: 1 });
    expect(await removeUserWatch("user-1", "x.com")).toBe(true);
    expect(deleteOneMock).toHaveBeenCalledWith({ userId: "user-1", domainName: "x.com" });
  });

  it("returns false when no matching pair existed (route maps to 404)", async () => {
    deleteOneMock.mockResolvedValueOnce({ deletedCount: 0 });
    expect(await removeUserWatch("user-1", "missing.com")).toBe(false);
  });
});

describe("listWatchesForCron", () => {
  it("populates userId with the notifier-projection, limits batchSize, lean", async () => {
    const leanMock = vi.fn().mockResolvedValue([{ _id: "w1" }]);
    const limitMock = vi.fn().mockReturnValue({ lean: leanMock });
    const populateMock = vi.fn().mockReturnValue({ limit: limitMock });
    findMock.mockReturnValue({ populate: populateMock });
    const result = await listWatchesForCron(100);
    expect(findMock).toHaveBeenCalledWith({});
    expect(populateMock).toHaveBeenCalledWith("userId", "email firstName lastName");
    expect(limitMock).toHaveBeenCalledWith(100);
    expect(result).toEqual([{ _id: "w1" }]);
  });
});

describe("recordWatchCheck", () => {
  it("$set lastCheckedAt + lastStatus", async () => {
    updateOneMock.mockResolvedValueOnce({ acknowledged: true });
    await recordWatchCheck("w1", "taken");
    const [filter, update] = updateOneMock.mock.calls[0];
    expect(filter).toEqual({ _id: "w1" });
    expect(update.$set.lastStatus).toBe("taken");
    expect(update.$set.lastCheckedAt).toBeInstanceOf(Date);
  });
});

describe("removeWatchById", () => {
  it("deleteOne({_id}) — one-shot cron deletion after notify", async () => {
    deleteOneMock.mockResolvedValueOnce({ deletedCount: 1 });
    await removeWatchById("w1");
    expect(deleteOneMock).toHaveBeenCalledWith({ _id: "w1" });
  });
});
