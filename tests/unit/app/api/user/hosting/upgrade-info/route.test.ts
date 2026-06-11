/**
 * Tests for `app/api/user/hosting/upgrade-info/route.ts` (slice
 * 7hk, part 2). Customer views eligible upgrade plans with
 * prorated charges for the time remaining on their current term.
 *
 * Pins:
 *  - Auth → 401
 *  - Missing ?domainName → 400 INVALID_PARAM
 *  - IDOR via findUserHosting(user._id, {domainName: lowercased});
 *    non-owner → 404 NOT_FOUND
 *  - **Active-only guard**: hosting.status !== 'active' → 400
 *    NOT_ELIGIBLE 'Only active hosting accounts can be upgraded'
 *    (suspended/pending/terminated all rejected)
 *  - **Expired-hosting guard**: remainingDays ≤ 0 → 400
 *    HOSTING_EXPIRED 'Hosting has expired. Please renew before
 *    upgrading.' (a customer must renew first; the upgrade flow
 *    must NOT silently absorb the expired state)
 *  - getPlanByPlanId null → 404 PLAN_NOT_FOUND (defensive)
 *  - listActivePlans returns all available plans
 *  - **Upgrades-only filter**: eligiblePlans = active plans where
 *    plan.price > currentPlan.price. Pinned because the customer
 *    UI must not let them downgrade through this endpoint (no
 *    pro-rated REFUND path implemented).
 *  - **Prorated pricing formula pinned VERBATIM**: chargeAmount =
 *    Math.max(100, Math.round((target - current) * remainingDays
 *    / 30)). ₹100 minimum floor — a tiny prorate (e.g. 1 remaining
 *    day on a small price gap) still costs at least ₹100 to deter
 *    abuse and absorb gateway fees.
 *  - Currency defaults to 'INR' when plan.currency missing
 *  - Response shape: `{success, data: {currentPlan, eligiblePlans,
 *    remainingDays, hasSubscription, expiryDate}}`
 *  - Outer catch → 500 INTERNAL_ERROR 'Failed to get upgrade info'
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const findUserHosting = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hostings", () => ({ findUserHosting }));

const getPlanByPlanId = vi.hoisted(() => vi.fn());
const listActivePlans = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hosting-plans", () => ({
  getPlanByPlanId,
  listActivePlans,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/user/hosting/upgrade-info/route";

const user = { _id: "U1", email: "alice@example.com" };
const NOW = new Date("2026-06-11T12:00:00.000Z").getTime();

function makeReq(qs = "") {
  const url = qs
    ? `https://example.com/api/user/hosting/upgrade-info?${qs}`
    : "https://example.com/api/user/hosting/upgrade-info";
  return new NextRequest(url, { method: "GET" });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  getUserFromRequest.mockReset().mockResolvedValue(user);
  findUserHosting.mockReset();
  getPlanByPlanId.mockReset();
  listActivePlans.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Auth gate", () => {
  it("no user → 401", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq("domainName=alice.com"));
    expect(res.status).toBe(401);
    expect(findUserHosting).not.toHaveBeenCalled();
  });
});

describe("Required ?domainName", () => {
  it("missing → 400 INVALID_PARAM", async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(400);
    expect(findUserHosting).not.toHaveBeenCalled();
  });
});

describe("IDOR + active-only + expired guards", () => {
  it("findUserHosting null → 404 NOT_FOUND", async () => {
    findUserHosting.mockResolvedValueOnce(null);
    const res = await GET(makeReq("domainName=stranger.com"));
    expect(res.status).toBe(404);
  });

  it("domainName is lowercased before lookup", async () => {
    findUserHosting.mockResolvedValueOnce(null);
    await GET(makeReq("domainName=ALICE.COM"));
    expect(findUserHosting).toHaveBeenCalledWith("U1", {
      domainName: "alice.com",
    });
  });

  it.each(["suspended", "pending", "terminated"])(
    "status=%p → 400 NOT_ELIGIBLE",
    async (status) => {
      findUserHosting.mockResolvedValueOnce({
        _id: "H1",
        status,
        expiryDate: new Date(NOW + 30 * 86_400_000),
        planId: "p_starter",
      });
      const res = await GET(makeReq("domainName=alice.com"));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe("NOT_ELIGIBLE");
    }
  );

  it("remainingDays ≤ 0 (already expired) → 400 HOSTING_EXPIRED", async () => {
    findUserHosting.mockResolvedValueOnce({
      _id: "H1",
      status: "active",
      expiryDate: new Date(NOW - 86_400_000), // yesterday
      planId: "p_starter",
    });
    const res = await GET(makeReq("domainName=alice.com"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("HOSTING_EXPIRED");
    expect(getPlanByPlanId).not.toHaveBeenCalled();
  });

  it("getPlanByPlanId null → 404 PLAN_NOT_FOUND (defensive)", async () => {
    findUserHosting.mockResolvedValueOnce({
      _id: "H1",
      status: "active",
      expiryDate: new Date(NOW + 30 * 86_400_000),
      planId: "p_orphan",
    });
    getPlanByPlanId.mockResolvedValueOnce(null);

    const res = await GET(makeReq("domainName=alice.com"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("PLAN_NOT_FOUND");
  });
});

describe("Upgrades-only filter (no downgrades exposed)", () => {
  it("only plans with price > currentPlan.price appear in eligiblePlans", async () => {
    findUserHosting.mockResolvedValueOnce({
      _id: "H1",
      status: "active",
      expiryDate: new Date(NOW + 30 * 86_400_000),
      planId: "p_starter",
      subscriptionId: undefined,
    });
    getPlanByPlanId.mockResolvedValueOnce({
      planId: "p_starter",
      name: "Starter",
      price: 500,
    });
    listActivePlans.mockResolvedValueOnce([
      { planId: "p_basic", name: "Basic", price: 300, features: [] },
      { planId: "p_starter", name: "Starter", price: 500, features: [] },
      { planId: "p_pro", name: "Pro", price: 1000, features: [] },
      { planId: "p_ent", name: "Enterprise", price: 2500, features: [] },
    ]);

    const res = await GET(makeReq("domainName=alice.com"));
    const body = await res.json();
    expect(body.data.eligiblePlans).toHaveLength(2);
    expect(body.data.eligiblePlans.map((p: { planId: string }) => p.planId)).toEqual([
      "p_pro",
      "p_ent",
    ]);
  });

  it("same-price plan (current plan itself) is NOT in eligiblePlans (strict > not >=)", async () => {
    findUserHosting.mockResolvedValueOnce({
      _id: "H1",
      status: "active",
      expiryDate: new Date(NOW + 30 * 86_400_000),
      planId: "p_starter",
    });
    getPlanByPlanId.mockResolvedValueOnce({
      planId: "p_starter",
      name: "Starter",
      price: 500,
    });
    listActivePlans.mockResolvedValueOnce([
      { planId: "p_starter", name: "Starter", price: 500, features: [] },
    ]);

    const body = await (
      await GET(makeReq("domainName=alice.com"))
    ).json();
    expect(body.data.eligiblePlans).toHaveLength(0);
  });
});

describe("Prorated pricing formula", () => {
  it("formula pinned VERBATIM: Math.max(100, round((target-current)*remainingDays/30))", async () => {
    // current=500, target=1500, remainingDays=15 →
    // (1500-500) * 15 / 30 = 500, max(100, 500) = 500
    findUserHosting.mockResolvedValueOnce({
      _id: "H1",
      status: "active",
      expiryDate: new Date(NOW + 15 * 86_400_000), // 15 days
      planId: "p_starter",
    });
    getPlanByPlanId.mockResolvedValueOnce({
      planId: "p_starter",
      price: 500,
    });
    listActivePlans.mockResolvedValueOnce([
      { planId: "p_pro", name: "Pro", price: 1500, features: [] },
    ]);

    const body = await (
      await GET(makeReq("domainName=alice.com"))
    ).json();
    expect(body.data.eligiblePlans[0].chargeAmount).toBe(500);
    expect(body.data.remainingDays).toBe(15);
  });

  it("**₹100 minimum floor**: tiny prorate is bumped to 100 (anti-gateway-fee-trap)", async () => {
    // current=500, target=600, remainingDays=3 →
    // (600-500) * 3 / 30 = 10, max(100, 10) = 100
    findUserHosting.mockResolvedValueOnce({
      _id: "H1",
      status: "active",
      expiryDate: new Date(NOW + 3 * 86_400_000),
      planId: "p_starter",
    });
    getPlanByPlanId.mockResolvedValueOnce({
      planId: "p_starter",
      price: 500,
    });
    listActivePlans.mockResolvedValueOnce([
      { planId: "p_basic_plus", name: "Basic+", price: 600, features: [] },
    ]);

    const body = await (
      await GET(makeReq("domainName=alice.com"))
    ).json();
    expect(body.data.eligiblePlans[0].chargeAmount).toBe(100);
  });

  it("Math.round applied (not Math.floor / Math.ceil)", async () => {
    // current=500, target=1500, remainingDays=29 →
    // (1500-500) * 29 / 30 = 966.66..., round → 967
    findUserHosting.mockResolvedValueOnce({
      _id: "H1",
      status: "active",
      expiryDate: new Date(NOW + 29 * 86_400_000),
      planId: "p_starter",
    });
    getPlanByPlanId.mockResolvedValueOnce({
      planId: "p_starter",
      price: 500,
    });
    listActivePlans.mockResolvedValueOnce([
      { planId: "p_pro", name: "Pro", price: 1500, features: [] },
    ]);

    const body = await (
      await GET(makeReq("domainName=alice.com"))
    ).json();
    expect(body.data.eligiblePlans[0].chargeAmount).toBe(967);
  });
});

describe("Currency default + response shape", () => {
  it("plan.currency missing → defaults to 'INR'", async () => {
    findUserHosting.mockResolvedValueOnce({
      _id: "H1",
      status: "active",
      expiryDate: new Date(NOW + 10 * 86_400_000),
      planId: "p_starter",
    });
    getPlanByPlanId.mockResolvedValueOnce({
      planId: "p_starter",
      price: 500,
    });
    listActivePlans.mockResolvedValueOnce([
      {
        planId: "p_pro",
        name: "Pro",
        price: 1000,
        features: [],
        // currency missing
      },
    ]);

    const body = await (
      await GET(makeReq("domainName=alice.com"))
    ).json();
    expect(body.data.eligiblePlans[0].currency).toBe("INR");
  });

  it("response includes currentPlan + eligiblePlans + remainingDays + hasSubscription + expiryDate", async () => {
    const expiry = new Date(NOW + 20 * 86_400_000);
    findUserHosting.mockResolvedValueOnce({
      _id: "H1",
      status: "active",
      expiryDate: expiry,
      planId: "p_starter",
      subscriptionId: "sub_X",
    });
    getPlanByPlanId.mockResolvedValueOnce({
      planId: "p_starter",
      name: "Starter",
      price: 500,
    });
    listActivePlans.mockResolvedValueOnce([
      { planId: "p_pro", name: "Pro", price: 1000, features: [] },
    ]);

    const body = await (
      await GET(makeReq("domainName=alice.com"))
    ).json();
    expect(body.success).toBe(true);
    expect(body.data.currentPlan).toEqual({
      planId: "p_starter",
      name: "Starter",
      price: 500,
    });
    expect(body.data.eligiblePlans).toHaveLength(1);
    expect(body.data.remainingDays).toBe(20);
    expect(body.data.hasSubscription).toBe(true);
    expect(new Date(body.data.expiryDate).toISOString()).toBe(
      expiry.toISOString()
    );
  });

  it("hasSubscription false when subscriptionId absent", async () => {
    findUserHosting.mockResolvedValueOnce({
      _id: "H1",
      status: "active",
      expiryDate: new Date(NOW + 20 * 86_400_000),
      planId: "p_starter",
      // no subscriptionId
    });
    getPlanByPlanId.mockResolvedValueOnce({
      planId: "p_starter",
      price: 500,
    });
    listActivePlans.mockResolvedValueOnce([]);

    const body = await (
      await GET(makeReq("domainName=alice.com"))
    ).json();
    expect(body.data.hasSubscription).toBe(false);
  });
});

describe("Outer catch", () => {
  it("findUserHosting throw → 500 INTERNAL_ERROR 'Failed to get upgrade info' (no leak)", async () => {
    findUserHosting.mockRejectedValueOnce(new Error("Mongo timeout"));
    const res = await GET(makeReq("domainName=alice.com"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.error).toBe("Failed to get upgrade info");
    expect(body.error).not.toContain("Mongo");
  });
});
