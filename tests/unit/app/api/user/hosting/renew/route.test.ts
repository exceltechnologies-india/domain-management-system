/**
 * Tests for `app/api/user/hosting/renew/route.ts` (slice 7i3, part 1).
 *
 * Customer-initiated hosting renewal — creates a Razorpay order + a
 * pending internal Order. 12-month-only renewal, price computed
 * server-side.
 *
 * Threat model:
 *  - **Client-supplied price**: trusted client could submit amount=1.
 *    Pinned: amount is `plan.price * 12` server-side; body has no
 *    amount/price fields.
 *  - **Anti-IDOR**: `findUserHosting` keyed on session user._id only.
 *  - **Mass-termination order spam**: a logged-in attacker could
 *    mint pending orders endlessly. Pinned: per-user rate-limit
 *    5/min, NOT IP — so a multi-customer office doesn't get
 *    throttled by one bad actor.
 *
 * Other pins:
 *  - Auth → 401 UNAUTHORIZED; rate-limit NOT consulted
 *  - Per-user key 'hosting_renew:${user._id}'
 *  - zod: domainName trim+lower 3-253
 *  - 404 NOT_FOUND on missing hosting
 *  - 'terminated' status → 400 HOSTING_TERMINATED (specific msg)
 *  - non-RENEWABLE_STATUSES (cancelled, etc.) → 400 HOSTING_NOT_RENEWABLE
 *  - active + >15 days to expiry → 400 TOO_EARLY_TO_RENEW with
 *    days remaining
 *  - active + exactly 15 days → eligible (boundary inclusive)
 *  - active + <15 days → eligible
 *  - expired → eligible (no early-renew guard)
 *  - suspended → eligible
 *  - getPlanByPlanId null → 404 PLAN_NOT_FOUND
 *  - Renewal locked to 12 months: price = plan.price * 12
 *  - orderId pattern: 'rnw_${ts}_${rand}'
 *  - Razorpay metadata: type='hosting_renewal', domain_name, user_id
 *    (3 fields exactly)
 *  - Order: orderType='renewal', bookingStatus[0] step='payment_verified'
 *    progress:10
 *  - Outer catch → 500 INTERNAL_ERROR; sentinel NOT leaked
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

import { POST } from "@/app/api/user/hosting/renew/route";

function makeReq(body: unknown) {
  return new NextRequest("https://example.com/api/user/hosting/renew", {
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

function activeHosting(daysUntilExpiry: number) {
  return {
    _id: "H1",
    domainName: "example.com",
    status: "active",
    planId: "starter",
    expiryDate: new Date(Date.now() + daysUntilExpiry * 86_400_000),
  };
}

function setupHappy(daysUntilExpiry = 10) {
  getUserFromRequest.mockResolvedValue(user);
  checkKey.mockResolvedValue({ allowed: true });
  findUserHosting.mockResolvedValue(activeHosting(daysUntilExpiry));
  getPlanByPlanId.mockResolvedValue({
    planId: "starter",
    name: "Starter",
    price: 500,
    directAdminPackage: "Starter",
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

describe("Auth + rate-limit", () => {
  it("no user → 401 UNAUTHORIZED; rate-limit NOT consulted", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ domainName: "example.com" }));
    expect(res.status).toBe(401);
    expect(checkKey).not.toHaveBeenCalled();
  });

  it("rate-limit denied → 429", async () => {
    getUserFromRequest.mockResolvedValueOnce(user);
    checkKey.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });
    const res = await POST(makeReq({ domainName: "example.com" }));
    expect(res.status).toBe(429);
    expect(findUserHosting).not.toHaveBeenCalled();
  });

  it("rate-limit keyed on `hosting_renew:${user._id}` (NOT IP)", async () => {
    setupHappy();
    await POST(makeReq({ domainName: "example.com" }));
    expect(checkKey).toHaveBeenCalledWith("hosting_renew:U1");
  });
});

describe("Zod schema", () => {
  it("missing domainName → 400", async () => {
    getUserFromRequest.mockResolvedValueOnce(user);
    checkKey.mockResolvedValueOnce({ allowed: true });
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    expect(findUserHosting).not.toHaveBeenCalled();
  });

  it("domain trim+lower applied before lookup", async () => {
    setupHappy();
    await POST(makeReq({ domainName: "  EXAMPLE.COM  " }));
    expect(findUserHosting).toHaveBeenCalledWith(
      "U1",
      expect.objectContaining({ domainName: "example.com" })
    );
  });
});

describe("Anti-IDOR scope", () => {
  it("findUserHosting keyed on session user._id (body override ignored)", async () => {
    setupHappy();
    await POST(
      makeReq({
        domainName: "example.com",
        userId: "U_HOSTILE",
      } as Record<string, unknown>)
    );
    expect(findUserHosting).toHaveBeenCalledWith(
      "U1",
      expect.objectContaining({ domainName: "example.com" })
    );
  });
});

describe("Status guards", () => {
  beforeEach(() => {
    getUserFromRequest.mockResolvedValue(user);
    checkKey.mockResolvedValue({ allowed: true });
  });

  it("hosting not found → 404 NOT_FOUND", async () => {
    findUserHosting.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ domainName: "example.com" }));
    expect(res.status).toBe(404);
  });

  it("status='terminated' → 400 HOSTING_TERMINATED (specific message)", async () => {
    findUserHosting.mockResolvedValueOnce({
      ...activeHosting(30),
      status: "terminated",
    });
    const res = await POST(makeReq({ domainName: "example.com" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("HOSTING_TERMINATED");
    expect(body.error).toContain("Terminated");
  });

  it("status='cancelled' (non-renewable, not 'terminated') → 400 HOSTING_NOT_RENEWABLE", async () => {
    findUserHosting.mockResolvedValueOnce({
      ...activeHosting(30),
      status: "cancelled",
    });
    const res = await POST(makeReq({ domainName: "example.com" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("HOSTING_NOT_RENEWABLE");
  });

  it("status='pending' → 400 HOSTING_NOT_RENEWABLE", async () => {
    findUserHosting.mockResolvedValueOnce({
      ...activeHosting(30),
      status: "pending",
    });
    const res = await POST(makeReq({ domainName: "example.com" }));
    expect(res.status).toBe(400);
  });
});

describe("15-day early-renewal guard", () => {
  beforeEach(() => {
    getUserFromRequest.mockResolvedValue(user);
    checkKey.mockResolvedValue({ allowed: true });
    getPlanByPlanId.mockResolvedValue({
      planId: "starter",
      name: "Starter",
      price: 500,
      directAdminPackage: "Starter",
    });
    rzpCreateOrder.mockResolvedValue({ id: "order_rzp" });
    createOrder.mockImplementation(async (data) => data);
  });

  it("active + 30 days until expiry → 400 TOO_EARLY_TO_RENEW with days remaining", async () => {
    findUserHosting.mockResolvedValueOnce(activeHosting(30));
    const res = await POST(makeReq({ domainName: "example.com" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("TOO_EARLY_TO_RENEW");
    expect(body.error).toMatch(/30 days/);
  });

  it("active + 14 days → ELIGIBLE (within 15-day window)", async () => {
    findUserHosting.mockResolvedValueOnce(activeHosting(14));
    const res = await POST(makeReq({ domainName: "example.com" }));
    expect(res.status).toBe(200);
  });

  it("active + 1 day → ELIGIBLE", async () => {
    findUserHosting.mockResolvedValueOnce(activeHosting(1));
    const res = await POST(makeReq({ domainName: "example.com" }));
    expect(res.status).toBe(200);
  });

  it("**expired status → ELIGIBLE; no early-renew guard applied** (expired is past-zero, customer must renew)", async () => {
    findUserHosting.mockResolvedValueOnce({
      ...activeHosting(-5), // expired 5 days ago
      status: "expired",
    });
    const res = await POST(makeReq({ domainName: "example.com" }));
    expect(res.status).toBe(200);
  });

  it("suspended status → ELIGIBLE; no early-renew guard applied", async () => {
    findUserHosting.mockResolvedValueOnce({
      ...activeHosting(60),
      status: "suspended",
    });
    const res = await POST(makeReq({ domainName: "example.com" }));
    expect(res.status).toBe(200);
  });
});

describe("Plan lookup", () => {
  it("plan null → 404 PLAN_NOT_FOUND", async () => {
    getUserFromRequest.mockResolvedValueOnce(user);
    checkKey.mockResolvedValueOnce({ allowed: true });
    findUserHosting.mockResolvedValueOnce(activeHosting(10));
    getPlanByPlanId.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ domainName: "example.com" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("PLAN_NOT_FOUND");
  });
});

describe("12-month-locked pricing (server-authoritative)", () => {
  it("**price = plan.price × 12 = 500 × 12 = 6000; client-supplied amount IGNORED**", async () => {
    setupHappy();
    await POST(
      makeReq({
        domainName: "example.com",
        amount: 1, // hostile body
        period: 24, // hostile period override
      } as Record<string, unknown>)
    );
    expect(rzpCreateOrder).toHaveBeenCalledWith(
      6000,
      "INR",
      expect.any(String),
      expect.any(Object)
    );
  });
});

describe("Razorpay order shape", () => {
  it("metadata: type/domain_name/user_id (3 fields exactly)", async () => {
    setupHappy();
    await POST(makeReq({ domainName: "example.com" }));
    const meta = rzpCreateOrder.mock.calls[0][3];
    expect(meta).toEqual({
      type: "hosting_renewal",
      domain_name: "example.com",
      user_id: "U1",
    });
  });

  it("orderId starts with 'rnw_'", async () => {
    setupHappy();
    await POST(makeReq({ domainName: "example.com" }));
    const orderId = rzpCreateOrder.mock.calls[0][2];
    expect(orderId).toMatch(/^rnw_/);
  });
});

describe("Internal Order shape", () => {
  it("orderType:'renewal' + registrationPeriod:12 + periodUnit:'months' + bookingStatus", async () => {
    setupHappy();
    await POST(makeReq({ domainName: "example.com" }));
    const order = createOrder.mock.calls[0][0];
    expect(order.orderType).toBe("renewal");
    expect(order.status).toBe("pending");
    expect(order.amount).toBe(6000);
    expect(order.domains[0]).toEqual(
      expect.objectContaining({
        domainName: "example.com",
        price: 500, // per-month plan price
        registrationPeriod: 12,
        periodUnit: "months",
        itemType: "hosting",
        status: "pending",
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
  it("rzpCreateOrder throw → 500 INTERNAL_ERROR; sentinel NOT leaked", async () => {
    setupHappy();
    rzpCreateOrder.mockRejectedValueOnce(
      new Error("Razorpay 5xx — rzp_secret_LEAK_ME")
    );
    const res = await POST(makeReq({ domainName: "example.com" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain("rzp_secret_LEAK_ME");
  });
});
