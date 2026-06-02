/**
 * Tests for `@/lib/services/hostings` (rescan-4 slice 7ek).
 * Hosting use-case helpers. Pins:
 *  - getHostingById: optional populate projects only 6 user fields
 *    (email/firstName/lastName/whatsappNumber/phone/phoneCc) — cron
 *    batch sizes can't afford the full User doc
 *  - findUserHosting: filter starts with {userId} + optional
 *    {domainName} narrowing; default returns mongoose query (not lean)
 *  - userHasAnyHosting: cheap-existence check uses select('_id').lean()
 *    + returns boolean (no full doc haul)
 *  - listHostingsForUser: default limit 50 + createdAt:-1 sort; limit<=0
 *    returns ALL (no truncation — dashboard sync needs everything)
 *  - findUserHostingById: scoped to userId for safe ownership pattern
 *    on /api/user/hosting/[id]/* routes
 *  - listDueServiceHostingCandidates: $or with 3 processing_until forms
 *    (null/missing/expired) AND status $nin failed/terminated
 *  - lockHostingForScheduler: findOneAndUpdate with `new:false` (returns
 *    the PRE-update doc so caller can tell whether the lock was newly
 *    acquired vs. extended)
 *  - releaseHostingSchedulerLock: GUARDED by the original lockExpiry
 *    (a concurrent worker can't accidentally release someone else's lock)
 *  - upsertHostingFromDirectAdminStats: passes through to updateOne
 *    with {upsert:true}
 *  - deleteHostingsByIdOrUsername: filters by id OR username; returns
 *    {deletedCount, matchedHostings} for caller logging
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const connectDB = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

const Hosting = vi.hoisted(() => ({
  findById: vi.fn(),
  findOne: vi.fn(),
  find: vi.fn(),
  findOneAndUpdate: vi.fn(),
  updateOne: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
  deleteMany: vi.fn(),
}));
vi.mock("@/models/Hosting", () => ({ default: Hosting }));

import {
  getHostingById,
  findUserHosting,
  userHasAnyHosting,
  listHostingsForUser,
  findUserHostingById,
  touchHostingsLastSyncedForUser,
  createHosting,
  listDueServiceHostingCandidates,
  lockHostingForScheduler,
  releaseHostingSchedulerLock,
  listUserHostingsByDomain,
  upsertHostingFromDirectAdminStats,
  listExpiredActiveHostings,
  listAllHostingsForDirectAdminDiag,
  listHostingsByDirectAdminUsername,
  deleteHostingsByIdOrUsername,
} from "@/lib/services/hostings";

beforeEach(() => {
  connectDB.mockReset();
  Object.values(Hosting).forEach((fn) =>
    (fn as ReturnType<typeof vi.fn>).mockReset()
  );
});

describe("getHostingById", () => {
  it("default: findById, no populate, no lean", async () => {
    const fakeQuery = { populate: vi.fn(), lean: vi.fn() };
    Hosting.findById.mockReturnValueOnce(fakeQuery);
    await getHostingById("H1");
    expect(Hosting.findById).toHaveBeenCalledWith("H1");
    expect(fakeQuery.populate).not.toHaveBeenCalled();
    expect(fakeQuery.lean).not.toHaveBeenCalled();
  });

  it("populateUser:true projects the 6 user fields only (cron-batch efficient)", async () => {
    const fakeQuery = { populate: vi.fn().mockReturnThis(), lean: vi.fn() };
    Hosting.findById.mockReturnValueOnce(fakeQuery);
    await getHostingById("H1", { populateUser: true });
    expect(fakeQuery.populate).toHaveBeenCalledWith(
      "userId",
      "email firstName lastName whatsappNumber phone phoneCc"
    );
  });

  it("lean:true → .lean()", async () => {
    const leanResult = { _id: "H1" };
    const fakeQuery = {
      populate: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue(leanResult),
    };
    Hosting.findById.mockReturnValueOnce(fakeQuery);
    const result = await getHostingById("H1", { lean: true });
    expect(result).toBe(leanResult);
  });
});

describe("findUserHosting", () => {
  it("filter has userId only when domainName omitted", async () => {
    Hosting.findOne.mockResolvedValueOnce(null);
    await findUserHosting("U1");
    expect(Hosting.findOne).toHaveBeenCalledWith({ userId: "U1" });
  });

  it("filter narrows by domainName when supplied", async () => {
    Hosting.findOne.mockResolvedValueOnce(null);
    await findUserHosting("U1", { domainName: "x.com" });
    expect(Hosting.findOne).toHaveBeenCalledWith({
      userId: "U1",
      domainName: "x.com",
    });
  });
});

describe("userHasAnyHosting", () => {
  it("uses select('_id').lean() + returns boolean", async () => {
    const select = vi.fn().mockReturnThis();
    const lean = vi.fn().mockResolvedValue({ _id: "x" });
    Hosting.findOne.mockReturnValueOnce({ select, lean });
    expect(await userHasAnyHosting("U1")).toBe(true);
    expect(select).toHaveBeenCalledWith("_id");
    expect(lean).toHaveBeenCalled();
  });

  it("no doc → false", async () => {
    const select = vi.fn().mockReturnThis();
    const lean = vi.fn().mockResolvedValue(null);
    Hosting.findOne.mockReturnValueOnce({ select, lean });
    expect(await userHasAnyHosting("U1")).toBe(false);
  });
});

describe("listHostingsForUser", () => {
  it("default limit 50 + createdAt:-1 sort", async () => {
    const limit = vi.fn().mockResolvedValueOnce([]);
    const sort = vi.fn().mockReturnValue({ limit });
    Hosting.find.mockReturnValueOnce({ sort });
    await listHostingsForUser("U1");
    expect(Hosting.find).toHaveBeenCalledWith({ userId: "U1" });
    expect(sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(limit).toHaveBeenCalledWith(50);
  });

  it("limit:0 → NO .limit() call (returns all — dashboard sync flatten)", async () => {
    const limit = vi.fn().mockResolvedValueOnce([]);
    const sort = vi.fn().mockResolvedValue([]);
    Hosting.find.mockReturnValueOnce({ sort });
    await listHostingsForUser("U1", { limit: 0 });
    expect(limit).not.toHaveBeenCalled();
  });

  it("limit:-1 (negative) also returns all", async () => {
    const limit = vi.fn().mockResolvedValueOnce([]);
    const sort = vi.fn().mockResolvedValue([]);
    Hosting.find.mockReturnValueOnce({ sort });
    await listHostingsForUser("U1", { limit: -1 });
    expect(limit).not.toHaveBeenCalled();
  });
});

describe("findUserHostingById", () => {
  it("scopes by BOTH _id AND userId (ownership pattern)", async () => {
    Hosting.findOne.mockResolvedValueOnce(null);
    await findUserHostingById("H1", "U1");
    expect(Hosting.findOne).toHaveBeenCalledWith({
      _id: "H1",
      userId: "U1",
    });
  });
});

describe("touchHostingsLastSyncedForUser", () => {
  it("updateMany({userId}, $set lastSyncedAt:Date) — dashboard sync throttle", async () => {
    Hosting.updateMany.mockResolvedValueOnce({});
    await touchHostingsLastSyncedForUser("U1");
    const [filter, update] = Hosting.updateMany.mock.calls[0];
    expect(filter).toEqual({ userId: "U1" });
    expect(update.$set.lastSyncedAt).toBeInstanceOf(Date);
  });
});

describe("createHosting", () => {
  it("thin pass-through to Hosting.create", async () => {
    const payload = { userId: "U1", domainName: "x.com" };
    Hosting.create.mockResolvedValueOnce({ ...payload, _id: "H1" });
    await createHosting(payload);
    expect(Hosting.create).toHaveBeenCalledWith(payload);
  });
});

describe("listDueServiceHostingCandidates", () => {
  it("$or covers 3 processing_until forms + status $nin failed/terminated + slim projection", async () => {
    const lean = vi.fn().mockResolvedValueOnce([]);
    const limit = vi.fn().mockReturnValue({ lean });
    const select = vi.fn().mockReturnValue({ limit });
    Hosting.find.mockReturnValueOnce({ select });
    const now = new Date("2026-06-01");
    await listDueServiceHostingCandidates({ now, batchSize: 50 });
    const [filter] = Hosting.find.mock.calls[0];
    expect(filter.next_action_at).toEqual({ $lte: now });
    expect(filter.status).toEqual({ $nin: ["failed", "terminated"] });
    expect(filter.$or).toEqual([
      { processing_until: null },
      { processing_until: { $exists: false } },
      { processing_until: { $lt: now } },
    ]);
    expect(select).toHaveBeenCalledWith("_id domainName");
    expect(limit).toHaveBeenCalledWith(50);
  });
});

describe("lockHostingForScheduler", () => {
  it("findOneAndUpdate with new:false (returns PRE-update doc — caller distinguishes 'newly locked' vs 'extended')", async () => {
    Hosting.findOneAndUpdate.mockResolvedValueOnce(null);
    const now = new Date("2026-06-01");
    const expiry = new Date("2026-06-01T01:00:00Z");
    await lockHostingForScheduler({ hostingId: "H1", now, lockExpiry: expiry });
    const [filter, update, opts] = Hosting.findOneAndUpdate.mock.calls[0];
    expect(filter._id).toBe("H1");
    expect(filter.$or).toEqual([
      { processing_until: null },
      { processing_until: { $exists: false } },
      { processing_until: { $lt: now } },
    ]);
    expect(update).toEqual({ $set: { processing_until: expiry } });
    expect(opts).toEqual({ new: false });
  });
});

describe("releaseHostingSchedulerLock", () => {
  it("GUARDED by lockExpiry (concurrent worker can't release someone else's lock)", async () => {
    Hosting.updateOne.mockResolvedValueOnce({});
    const expiry = new Date("2026-06-01T01:00:00Z");
    await releaseHostingSchedulerLock({ hostingId: "H1", lockExpiry: expiry });
    expect(Hosting.updateOne).toHaveBeenCalledWith(
      { _id: "H1", processing_until: expiry },
      { $set: { processing_until: null } }
    );
  });
});

describe("listUserHostingsByDomain", () => {
  it("filter by userId + domainName + sort newest-first + lean", async () => {
    const lean = vi.fn().mockResolvedValueOnce([]);
    const sort = vi.fn().mockReturnValue({ lean });
    Hosting.find.mockReturnValueOnce({ sort });
    await listUserHostingsByDomain("U1", "x.com");
    expect(Hosting.find).toHaveBeenCalledWith({
      userId: "U1",
      domainName: "x.com",
    });
    expect(sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(lean).toHaveBeenCalled();
  });
});

describe("upsertHostingFromDirectAdminStats", () => {
  it("updateOne with $set + $setOnInsert + upsert:true", async () => {
    Hosting.updateOne.mockResolvedValueOnce({});
    await upsertHostingFromDirectAdminStats({
      filter: { directAdminUsername: "alice" },
      set: { status: "active" },
      setOnInsert: { createdAt: new Date() },
    });
    const [filter, update, opts] = Hosting.updateOne.mock.calls[0];
    expect(filter).toEqual({ directAdminUsername: "alice" });
    expect(update.$set).toEqual({ status: "active" });
    expect(update.$setOnInsert).toBeDefined();
    expect(opts).toEqual({ upsert: true });
  });
});

describe("listExpiredActiveHostings", () => {
  it("filter: status:active + expiryDate $lt cutoff + $ne null + slim projection", async () => {
    const lean = vi.fn().mockResolvedValueOnce([]);
    const select = vi.fn().mockReturnValue({ lean });
    Hosting.find.mockReturnValueOnce({ select });
    const cutoff = new Date("2026-06-01");
    await listExpiredActiveHostings(cutoff);
    const [filter] = Hosting.find.mock.calls[0];
    expect(filter.status).toBe("active");
    expect(filter.expiryDate).toEqual({ $lt: cutoff, $ne: null });
    expect(select).toHaveBeenCalledWith("_id domainName directAdminUsername");
  });
});

describe("listAllHostingsForDirectAdminDiag", () => {
  it("projects to the 3-field DA cross-reference shape + lean", async () => {
    const lean = vi.fn().mockResolvedValueOnce([]);
    Hosting.find.mockReturnValueOnce({ lean });
    await listAllHostingsForDirectAdminDiag();
    const [filter, projection] = Hosting.find.mock.calls[0];
    expect(filter).toEqual({});
    expect(projection).toBe("directAdminUsername domainName status");
    expect(lean).toHaveBeenCalled();
  });
});

describe("listHostingsByDirectAdminUsername", () => {
  it("filter by directAdminUsername", async () => {
    Hosting.find.mockResolvedValueOnce([]);
    await listHostingsByDirectAdminUsername("alice");
    expect(Hosting.find).toHaveBeenCalledWith({ directAdminUsername: "alice" });
  });
});

describe("deleteHostingsByIdOrUsername", () => {
  it("by hostingId: filter by _id; returns {deletedCount, matchedHostings}", async () => {
    const matched = [{ _id: "H1", domainName: "x.com" }];
    Hosting.find.mockResolvedValueOnce(matched);
    Hosting.deleteMany.mockResolvedValueOnce({ deletedCount: 1 });
    const result = await deleteHostingsByIdOrUsername({ hostingId: "H1" });
    expect(Hosting.find).toHaveBeenCalledWith({ _id: "H1" });
    expect(Hosting.deleteMany).toHaveBeenCalledWith({ _id: "H1" });
    expect(result).toEqual({ deletedCount: 1, matchedHostings: matched });
  });

  it("by directAdminUsername: filter by that field (legacy multi-row support)", async () => {
    Hosting.find.mockResolvedValueOnce([]);
    Hosting.deleteMany.mockResolvedValueOnce({ deletedCount: 0 });
    await deleteHostingsByIdOrUsername({ directAdminUsername: "alice" });
    expect(Hosting.find).toHaveBeenCalledWith({
      directAdminUsername: "alice",
    });
  });

  it("missing deletedCount → falls back to 0 (older mongoose driver guard)", async () => {
    Hosting.find.mockResolvedValueOnce([]);
    Hosting.deleteMany.mockResolvedValueOnce({});
    const result = await deleteHostingsByIdOrUsername({ hostingId: "missing" });
    expect(result.deletedCount).toBe(0);
  });
});
