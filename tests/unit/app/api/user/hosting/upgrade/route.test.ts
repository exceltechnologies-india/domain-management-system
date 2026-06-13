/**
 * Tests for `app/api/user/hosting/upgrade/route.ts` (slice 7i1, part 1).
 *
 * Customer hosting-plan upgrade — creates a Razorpay order + a
 * pending internal Order with server-computed prorated pricing.
 *
 * Threat model:
 *  - **Client-supplied amount trust**: a hostile client could pass
 *    a tiny amount and complete the upgrade for pennies. Pinned:
 *    the route ignores any body amount and recomputes server-side
 *    from current+target plan prices.
 *  - **Cross-tenant hosting upgrade**: a customer must NOT be able
 *    to upgrade another customer's hosting. Pinned: `findUserHosting`
 *    keyed on session user._id.
 *  - **Downgrade smuggled as upgrade**: a refactor that dropped the
 *    `targetPlan.price > currentPlan.price` check would let a
 *    customer "upgrade" to a cheaper plan, locking in lower
 *    pricing. Pinned with explicit 400.
 *
 * Other pins:
 *  - Auth gate → 401 UNAUTHORIZED; no rate-limit consulted
 *  - Per-user rate-limit (5/min) keyed `hosting_upgrade:${user._id}`
 *  - zod: domainName trim+lower 3-253; targetPlanId min:1
 *  - hosting not found → 404 NOT_FOUND
 *  - hosting.status !== 'active' → 400 NOT_ELIGIBLE
 *  - remainingDays ≤ 0 → 400 HOSTING_EXPIRED
 *  - currentPlan missing → 404 PLAN_NOT_FOUND
 *  - targetPlan missing → 404 TARGET_PLAN_NOT_FOUND (called with
 *    { activeOnly: true })
 *  - Prorated math: round((target-current) × remainingDays / 30);
 *    ₹100 floor via Math.max(100, prorated)
 *  - Razorpay metadata: hosting_id, domain_name, from_plan, to_plan,
 *    user_id (5 fields exactly)
 *  - Order shape: bookingStatus[0] step='payment_verified', progress:10
 *  - orderId starts with 'upg_'
 *  - Outer catch → 500 INTERNAL_ERROR
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const checkKey = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit")>(
    "@/lib/rate-limit"
  );
  return {
    ...actual,
    rateLimiters: { hostingRenewUpgrade: { checkKey } },
  };
});

const findUserHosting = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hostings", () => ({ findUserHosting }));

const getPlanByPlanId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hosting-plans", () => ({ getPlanByPlanId }));

const createOrder = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({ createOrder }));

const rzpCreateOrder = vi.hoisted(() => vi.fn());
vi.mock("@/lib/razorpay", () => ({
  RazorpayService: { createOrder: rzpCreateOrder },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/user/hosting/upgrade/route";

function makeReq(body: unknown) {
  return new NextRequest("https://example.com/api/user/hosting/upgrade", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const user = {
  _id: "U1",
  email: "alice@example.com",
  firstName: "Alice",
  lastName: "Smith",
};

const VALID = { domainName: "example.com", targetPlanId: "premium" };

function setupHappy() {
  getUserFromRequest.mockResolvedValue(user);
  checkKey.mockResolvedValue({ allowed: true });
  findUserHosting.mockResolvedValue({
    _id: "H1",
    domainName: "example.com",
    status: "active",
    planId: "starter",
    expiryDate: new Date(Date.now() + 15 * 86_400_000), // 15 days remaining
  });
  getPlanByPlanId
    .mockResolvedValueOnce({
      planId: "starter",
      name: "Starter",
      price: 1000,
      directAdminPackage: "Starter",
    })
    .mockResolvedValueOnce({
      planId: "premium",
      name: "Premium",
      price: 5000,
      directAdminPackage: "Premium",
    });
  rzpCreateOrder.mockResolvedValue({ id: "order_rzp_xyz" });
  createOrder.mockImplementation(async (data) => data);
}

beforeEach(() => {
  getUserFromRequest.mockReset();
  checkKey.mockReset();
  findUserHosting.mockReset();
  getPlanByPlanId.mockReset();
  rzpCreateOrder.mockReset();
  createOrder.mockReset();
});

describe("Auth gate", () => {
  it("no user → 401 UNAUTHORIZED; rate-limit NOT consulted", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(401);
    expect(checkKey).not.toHaveBeenCalled();
  });
});

describe("Per-user rate-limit", () => {
  it("denied → 429; no downstream", async () => {
    getUserFromRequest.mockResolvedValueOnce(user);
    checkKey.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(429);
    expect(findUserHosting).not.toHaveBeenCalled();
  });

  it("rate-limit keyed on user._id (NOT IP) — anti-shared-network", async () => {
    setupHappy();
    await POST(makeReq(VALID));
    expect(checkKey).toHaveBeenCalledWith("hosting_upgrade:U1");
  });
});

describe("Zod schema", () => {
  it("missing targetPlanId → 400", async () => {
    getUserFromRequest.mockResolvedValueOnce(user);
    checkKey.mockResolvedValueOnce({ allowed: true });
    const res = await POST(makeReq({ domainName: "example.com" }));
    expect(res.status).toBe(400);
    expect(findUserHosting).not.toHaveBeenCalled();
  });

  it("domain trim+lower applied before lookup", async () => {
    setupHappy();
    await POST(makeReq({ domainName: "  EXAMPLE.COM  ", targetPlanId: "premium" }));
    expect(findUserHosting).toHaveBeenCalledWith(
      "U1",
      expect.objectContaining({ domainName: "example.com" })
    );
  });
});

describe("Anti-IDOR scope", () => {
  it("findUserHosting keyed on session user._id (NOT body override)", async () => {
    setupHappy();
    await POST(
      makeReq({ ...VALID, userId: "U_HOSTILE" } as Record<string, unknown>)
    );
    expect(findUserHosting).toHaveBeenCalledWith(
      "U1",
      expect.objectContaining({ domainName: "example.com" })
    );
  });
});

describe("Hosting eligibility gates", () => {
  beforeEach(() => {
    getUserFromRequest.mockResolvedValue(user);
    checkKey.mockResolvedValue({ allowed: true });
  });

  it("hosting not found → 404 NOT_FOUND", async () => {
    findUserHosting.mockResolvedValueOnce(null);
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(404);
  });

  it("hosting.status !== 'active' → 400 NOT_ELIGIBLE", async () => {
    findUserHosting.mockResolvedValueOnce({
      status: "suspended",
      expiryDate: new Date(Date.now() + 30 * 86_400_000),
      planId: "starter",
    });
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("NOT_ELIGIBLE");
  });

  it("remainingDays ≤ 0 (expired) → 400 HOSTING_EXPIRED", async () => {
    findUserHosting.mockResolvedValueOnce({
      status: "active",
      expiryDate: new Date(Date.now() - 86_400_000), // expired yesterday
      planId: "starter",
    });
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("HOSTING_EXPIRED");
  });
});

describe("Plan lookups", () => {
  beforeEach(() => {
    getUserFromRequest.mockResolvedValue(user);
    checkKey.mockResolvedValue({ allowed: true });
    findUserHosting.mockResolvedValue({
      _id: "H1",
      domainName: "example.com",
      status: "active",
      planId: "starter",
      expiryDate: new Date(Date.now() + 15 * 86_400_000),
    });
  });

  it("currentPlan null → 404 PLAN_NOT_FOUND", async () => {
    getPlanByPlanId.mockResolvedValueOnce(null);
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("PLAN_NOT_FOUND");
  });

  it("targetPlan null → 404 TARGET_PLAN_NOT_FOUND; called with activeOnly:true", async () => {
    getPlanByPlanId
      .mockResolvedValueOnce({ planId: "starter", price: 1000 })
      .mockResolvedValueOnce(null);
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("TARGET_PLAN_NOT_FOUND");
    expect(getPlanByPlanId).toHaveBeenLastCalledWith(
      "premium",
      expect.objectContaining({ activeOnly: true })
    );
  });

  it("**DOWNGRADE BLOCKED: target.price ≤ current.price → 400 INVALID_UPGRADE**", async () => {
    getPlanByPlanId
      .mockResolvedValueOnce({ planId: "premium", price: 5000 })
      .mockResolvedValueOnce({ planId: "starter", price: 1000 });
    const res = await POST(
      makeReq({ domainName: "example.com", targetPlanId: "starter" })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_UPGRADE");
    expect(rzpCreateOrder).not.toHaveBeenCalled();
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("equal price → 400 INVALID_UPGRADE (sidegrade rejected)", async () => {
    getPlanByPlanId
      .mockResolvedValueOnce({ planId: "starter", price: 1000 })
      .mockResolvedValueOnce({ planId: "starter_alt", price: 1000 });
    const res = await POST(
      makeReq({ domainName: "example.com", targetPlanId: "starter_alt" })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_UPGRADE");
  });
});

describe("Server-authoritative prorated math", () => {
  beforeEach(() => {
    getUserFromRequest.mockResolvedValue(user);
    checkKey.mockResolvedValue({ allowed: true });
    rzpCreateOrder.mockResolvedValue({ id: "order_rzp" });
    createOrder.mockImplementation(async (data) => data);
  });

  it("**typical prorate: (5000-1000) × 15 / 30 = 2000**", async () => {
    findUserHosting.mockResolvedValueOnce({
      _id: "H1",
      domainName: "example.com",
      status: "active",
      planId: "starter",
      expiryDate: new Date(Date.now() + 15 * 86_400_000),
    });
    getPlanByPlanId
      .mockResolvedValueOnce({ planId: "starter", price: 1000 })
      .mockResolvedValueOnce({
        planId: "premium",
        price: 5000,
        name: "Premium",
        directAdminPackage: "Premium",
      });
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(200);
    expect(rzpCreateOrder).toHaveBeenCalledWith(
      2000, // computed server-side
      "INR",
      expect.any(String),
      expect.any(Object)
    );
  });

  it("**₹100 FLOOR**: tiny prorate (5 days, ₹100 diff → 16) floors to ₹100", async () => {
    findUserHosting.mockResolvedValueOnce({
      _id: "H1",
      domainName: "example.com",
      status: "active",
      planId: "starter",
      expiryDate: new Date(Date.now() + 5 * 86_400_000),
    });
    getPlanByPlanId
      .mockResolvedValueOnce({ planId: "starter", price: 1000 })
      .mockResolvedValueOnce({
        planId: "premium_lite",
        price: 1100,
        name: "Premium Lite",
        directAdminPackage: "Standard",
      });
    const res = await POST(
      makeReq({ domainName: "example.com", targetPlanId: "premium_lite" })
    );
    expect(res.status).toBe(200);
    expect(rzpCreateOrder.mock.calls[0][0]).toBe(100);
  });

  it("**CLIENT-SUPPLIED AMOUNT IGNORED**: hostile body amount→9 ignored; server still computes 2000", async () => {
    findUserHosting.mockResolvedValueOnce({
      _id: "H1",
      domainName: "example.com",
      status: "active",
      planId: "starter",
      expiryDate: new Date(Date.now() + 15 * 86_400_000),
    });
    getPlanByPlanId
      .mockResolvedValueOnce({ planId: "starter", price: 1000 })
      .mockResolvedValueOnce({
        planId: "premium",
        price: 5000,
        name: "Premium",
        directAdminPackage: "Premium",
      });
    await POST(
      makeReq({
        domainName: "example.com",
        targetPlanId: "premium",
        amount: 9, // hostile
        chargeAmount: 9, // hostile
      } as Record<string, unknown>)
    );
    expect(rzpCreateOrder.mock.calls[0][0]).toBe(2000);
  });
});

describe("Razorpay metadata", () => {
  it("carries 5 fields: hosting_id, domain_name, from_plan, to_plan, user_id", async () => {
    setupHappy();
    await POST(makeReq(VALID));
    const meta = rzpCreateOrder.mock.calls[0][3];
    expect(meta).toEqual(
      expect.objectContaining({
        type: "hosting_upgrade",
        hosting_id: "H1",
        domain_name: "example.com",
        from_plan: "starter",
        to_plan: "premium",
        user_id: "U1",
      })
    );
  });

  it("orderId starts with 'upg_'", async () => {
    setupHappy();
    await POST(makeReq(VALID));
    const orderId = rzpCreateOrder.mock.calls[0][2];
    expect(orderId).toMatch(/^upg_/);
  });
});

describe("Internal Order shape", () => {
  it("orderType:'hosting_upgrade'; status:'pending'; bookingStatus[0] step='payment_verified' progress:10", async () => {
    setupHappy();
    await POST(makeReq(VALID));
    const order = createOrder.mock.calls[0][0];
    expect(order).toEqual(
      expect.objectContaining({
        orderType: "hosting_upgrade",
        status: "pending",
        currency: "INR",
        userId: "U1",
        userEmail: "alice@example.com",
        razorpayOrderId: "order_rzp_xyz",
      })
    );
    expect(order.upgradeDetails).toEqual(
      expect.objectContaining({
        hostingId: "H1",
        fromPlanId: "starter",
        toPlanId: "premium",
      })
    );
    expect(order.domains[0].bookingStatus[0]).toEqual(
      expect.objectContaining({
        step: "payment_verified",
        progress: 10,
      })
    );
  });
});

describe("Outer catch", () => {
  it("rzpCreateOrder throw → 500 INTERNAL_ERROR", async () => {
    setupHappy();
    rzpCreateOrder.mockRejectedValueOnce(new Error("Razorpay 5xx"));
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL_ERROR");
  });
});
