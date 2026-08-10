/**
 * Tests for `@/lib/services/hosting-plans` (rescan-4 slice 7du).
 * Read-heavy registry of hosting catalogue entries. Pins:
 *  - getPlanByPlanId default = no isActive filter; activeOnly:true adds it
 *  - getPlanById delegates to findById
 *  - getPlanByRazorpaySubscriptionPlanId uses $or on monthly+yearly fields
 *  - listActivePlans filters isActive:true + sorts price ASC by default,
 *    'price-desc' inverts, sort:false skips the sort entirely
 *  - getPlanByPlanIdLean adds .lean()
 *  - setPlanActive returns {matched, modified} from updateOne
 *  - upsertPlanByPlanId uses $set + upsert:true + new:true
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const connectDBMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDBMock }));

const findOneMock = vi.hoisted(() => vi.fn());
const findByIdMock = vi.hoisted(() => vi.fn());
const findMock = vi.hoisted(() => vi.fn());
const updateOneMock = vi.hoisted(() => vi.fn());
const findOneAndUpdateMock = vi.hoisted(() => vi.fn());
vi.mock("@/models/HostingPlan", () => ({
  default: {
    findOne: findOneMock,
    findById: findByIdMock,
    find: findMock,
    updateOne: updateOneMock,
    findOneAndUpdate: findOneAndUpdateMock,
  },
}));

import {
  getPlanByPlanId,
  getPlanById,
  getPlanByRazorpaySubscriptionPlanId,
  listActivePlans,
  getPlanByPlanIdLean,
  setPlanActive,
  upsertPlanByPlanId,
} from "@/lib/services/hosting-plans";

beforeEach(() => {
  connectDBMock.mockReset();
  findOneMock.mockReset();
  findByIdMock.mockReset();
  findMock.mockReset();
  updateOneMock.mockReset();
  findOneAndUpdateMock.mockReset();
});

describe("getPlanByPlanId", () => {
  // planId lookups are case-insensitive (live DB has mixed-case planIds) — the
  // filter is an anchored, regex-escaped `^<planId>$` with the `i` option.
  it("default: filters by planId (case-insensitive regex, no isActive filter)", async () => {
    findOneMock.mockResolvedValueOnce({ planId: "starter" });
    await getPlanByPlanId("starter");
    expect(connectDBMock).toHaveBeenCalled();
    expect(findOneMock).toHaveBeenCalledWith({
      planId: { $regex: "^starter$", $options: "i" },
    });
  });

  it("activeOnly:true adds isActive:true to the filter", async () => {
    findOneMock.mockResolvedValueOnce(null);
    await getPlanByPlanId("starter", { activeOnly: true });
    expect(findOneMock).toHaveBeenCalledWith({
      planId: { $regex: "^starter$", $options: "i" },
      isActive: true,
    });
  });
});

describe("getPlanById", () => {
  it("delegates to findById", async () => {
    findByIdMock.mockResolvedValueOnce({ _id: "abc" });
    await getPlanById("abc");
    expect(findByIdMock).toHaveBeenCalledWith("abc");
  });
});

describe("getPlanByRazorpaySubscriptionPlanId", () => {
  it("queries $or on monthly + yearly razorpayPlans fields", async () => {
    findOneMock.mockResolvedValueOnce({ planId: "plus" });
    await getPlanByRazorpaySubscriptionPlanId("plan_rzp_xyz");
    expect(findOneMock).toHaveBeenCalledWith({
      $or: [
        { "razorpayPlans.monthly": "plan_rzp_xyz" },
        { "razorpayPlans.yearly": "plan_rzp_xyz" },
      ],
    });
  });
});

describe("listActivePlans", () => {
  it("default sort = price ASC", async () => {
    const sortMock = vi.fn().mockResolvedValue([]);
    findMock.mockReturnValue({ sort: sortMock });
    await listActivePlans();
    expect(findMock).toHaveBeenCalledWith({ isActive: true });
    expect(sortMock).toHaveBeenCalledWith({ price: 1 });
  });

  it("sort:'price-desc' inverts to -1", async () => {
    const sortMock = vi.fn().mockResolvedValue([]);
    findMock.mockReturnValue({ sort: sortMock });
    await listActivePlans({ sort: "price-desc" });
    expect(sortMock).toHaveBeenCalledWith({ price: -1 });
  });

  it("sort:false skips sorting entirely (insertion order)", async () => {
    findMock.mockResolvedValueOnce([]);
    await listActivePlans({ sort: false });
    expect(findMock).toHaveBeenCalledWith({ isActive: true });
    // No .sort() chain — findMock returns the awaitable directly.
  });
});

describe("getPlanByPlanIdLean", () => {
  it("filters by planId + adds .lean()", async () => {
    const leanMock = vi.fn().mockResolvedValue({ planId: "starter" });
    findOneMock.mockReturnValue({ lean: leanMock });
    await getPlanByPlanIdLean("starter");
    expect(findOneMock).toHaveBeenCalledWith({
      planId: { $regex: "^starter$", $options: "i" },
    });
    expect(leanMock).toHaveBeenCalled();
  });
});

describe("setPlanActive", () => {
  it("calls updateOne({planId}, {$set:{isActive}}) and returns {matched, modified}", async () => {
    updateOneMock.mockResolvedValueOnce({ matchedCount: 1, modifiedCount: 1 });
    const result = await setPlanActive("starter", false);
    expect(updateOneMock).toHaveBeenCalledWith(
      { planId: "starter" },
      { $set: { isActive: false } }
    );
    expect(result).toEqual({ matched: 1, modified: 1 });
  });

  it("falls back to 0 when matchedCount/modifiedCount missing (older mongoose)", async () => {
    updateOneMock.mockResolvedValueOnce({});
    const result = await setPlanActive("missing", true);
    expect(result).toEqual({ matched: 0, modified: 0 });
  });
});

describe("upsertPlanByPlanId", () => {
  it("uses findOneAndUpdate with $set + upsert:true + new:true", async () => {
    findOneAndUpdateMock.mockResolvedValueOnce({ planId: "plus", price: 999 });
    await upsertPlanByPlanId("plus", { price: 999, isActive: true });
    expect(findOneAndUpdateMock).toHaveBeenCalledWith(
      { planId: "plus" },
      { $set: { planId: "plus", price: 999, isActive: true } },
      { upsert: true, new: true }
    );
  });

  it("planId is always included in $set even when not in `data` (so upsert-insert works)", async () => {
    findOneAndUpdateMock.mockResolvedValueOnce(null);
    await upsertPlanByPlanId("standalone", {});
    const [, update] = findOneAndUpdateMock.mock.calls[0];
    expect(update.$set.planId).toBe("standalone");
  });
});
