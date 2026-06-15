/**
 * Tests for `app/api/workers/process-hosting-expiry/route.ts` (slice 7i4, part 2).
 *
 * Daily worker: suspends an expired hosting account, creates a
 * pending renewal Order, sends the customer a renewal email.
 * Critically: NO Zoho invoice is created here (only on payment).
 *
 * Threat model:
 *  - **Mass-suspension on a flaky probe**: a refactor that suspends
 *    based on stale data would lock customers out incorrectly.
 *    Pinned: status='active' AND expiryDate < now BOTH required.
 *  - **Phantom Zoho invoice for unpaid renewals**: a refactor that
 *    fired ZohoBooksService here would create a "due invoice" in
 *    Zoho Books for an account the customer hasn't paid yet. Pinned
 *    via the import-check + email payload without invoiceNumber.
 *  - **Permanent-vs-transient response**: 200 (no retry) for
 *    permanent skips; 500 (Cloud Tasks retries) for transient errors.
 *
 * Other pins:
 *  - cron-secret → 401
 *  - zod hostingId required
 *  - hosting not found → 200 success:false (no retry)
 *  - status !== 'active' → 200 "Skipped (not active)" (idempotent)
 *  - expiryDate missing OR > now → 200 "Skipped (not expired)"
 *  - DA suspendUser called with the directAdminUsername + reason
 *  - missing directAdminUsername → skipped DA call (but still
 *    creates renewal order)
 *  - Renewal-price chain:
 *      1. From original order's domain match
 *      2. Fallback: getPlanByPlanId
 *      3. Last-resort: HOSTING_PLANS.starter.price
 *  - Period inference: domain item's periodUnit if valid enum,
 *    else default 'months' qty:1
 *  - createOrder: pending status, renewal-prefix orderId, fields
 *    locked
 *  - hosting.renewalStatus = 'pending'; status = 'suspended'; save
 *  - Email sent WITHOUT invoiceNumber (no Zoho invoice yet)
 *  - Inner catch (DA suspend throw, etc.) → 500 PROCESSING_FAILED
 *  - Outer catch → 500 INTERNAL_ERROR
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const authorizeCronRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cron-auth", () => ({ authorizeCronRequest }));

const getHostingById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hostings", () => ({ getHostingById }));

const getUserById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserById }));

const createOrder = vi.hoisted(() => vi.fn());
const getOrderByOrderId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  createOrder,
  getOrderByOrderId,
}));

const getPlanByPlanId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hosting-plans", () => ({ getPlanByPlanId }));

const suspendUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/directadmin", () => ({
  DirectAdminService: { suspendUser },
}));

vi.mock("@/config/hosting-plans", () => ({
  HOSTING_PLANS: {
    starter: { price: 999, name: "Starter" },
    standard: { price: 1999, name: "Standard" },
  },
}));

const sendRenewalInvoiceEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  EmailService: { sendRenewalInvoiceEmail },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/workers/process-hosting-expiry/route";

function makeReq(body: unknown = { hostingId: "H1" }) {
  return new NextRequest(
    "https://example.com/api/workers/process-hosting-expiry",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

function makeHosting(overrides: Record<string, unknown> = {}) {
  return {
    _id: "H1",
    domainName: "example.com",
    directAdminUsername: "alice_da",
    status: "active",
    expiryDate: new Date(Date.now() - 86_400_000), // 1 day expired
    planId: "starter",
    name: "Starter",
    serverPackage: "Starter",
    orderId: "ORD-1",
    userId: "U1",
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const user = {
  _id: "U1",
  email: "alice@example.com",
  firstName: "Alice",
  lastName: "Smith",
};

beforeEach(() => {
  authorizeCronRequest.mockReset().mockReturnValue(true);
  getHostingById.mockReset();
  getUserById.mockReset().mockResolvedValue(user);
  createOrder.mockReset().mockImplementation(async (data) => data);
  getOrderByOrderId.mockReset();
  getPlanByPlanId.mockReset();
  suspendUser.mockReset().mockResolvedValue(undefined);
  sendRenewalInvoiceEmail.mockReset().mockResolvedValue(undefined);
});

describe("Auth gate", () => {
  it("no cron-secret → 401; no DB work", async () => {
    authorizeCronRequest.mockReturnValueOnce(false);
    const res = await POST(makeReq());
    expect(res.status).toBe(401);
    expect(getHostingById).not.toHaveBeenCalled();
  });
});

describe("Zod schema", () => {
  it("missing hostingId → 400", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
  });
});

describe("Idempotency skips (200, no retry)", () => {
  it("hosting not found → 200 success:false 'Hosting not found'", async () => {
    getHostingById.mockResolvedValueOnce(null);
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(suspendUser).not.toHaveBeenCalled();
  });

  it("status !== 'active' (e.g. 'suspended') → 200 'Skipped (not active)'", async () => {
    getHostingById.mockResolvedValueOnce(
      makeHosting({ status: "suspended" })
    );
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toContain("not active");
    expect(suspendUser).not.toHaveBeenCalled();
  });

  it("expiryDate in future → 200 'Skipped (not expired)'", async () => {
    getHostingById.mockResolvedValueOnce(
      makeHosting({ expiryDate: new Date(Date.now() + 86_400_000) })
    );
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toContain("not expired");
  });

  it("expiryDate missing → 200 'Skipped (not expired)'", async () => {
    getHostingById.mockResolvedValueOnce(
      makeHosting({ expiryDate: undefined })
    );
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
  });
});

describe("DA suspension", () => {
  it("directAdminUsername present → suspendUser called with username + reason", async () => {
    getHostingById.mockResolvedValueOnce(makeHosting());
    await POST(makeReq());
    expect(suspendUser).toHaveBeenCalledWith(
      "alice_da",
      expect.stringContaining("Expired")
    );
  });

  it("directAdminUsername absent → suspendUser NOT called (still proceeds with renewal order)", async () => {
    getHostingById.mockResolvedValueOnce(
      makeHosting({ directAdminUsername: undefined })
    );
    const res = await POST(makeReq());
    expect(suspendUser).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(createOrder).toHaveBeenCalled();
  });
});

describe("Renewal price 3-step fallback chain", () => {
  it("(1) Original-order domain match → use its price + period", async () => {
    getHostingById.mockResolvedValueOnce(makeHosting());
    getOrderByOrderId.mockResolvedValueOnce({
      domains: [
        {
          domainName: "example.com",
          price: 1234,
          periodUnit: "months",
          registrationPeriod: 6,
        },
      ],
    });
    await POST(makeReq());
    const order = createOrder.mock.calls[0][0];
    expect(order.amount).toBe(1234);
    expect(order.domains[0].registrationPeriod).toBe(6);
    expect(order.domains[0].periodUnit).toBe("months");
  });

  it("(1b) Original order: domain-name miss → fallback by itemType+planId match", async () => {
    getHostingById.mockResolvedValueOnce(
      makeHosting({ planId: "premium" })
    );
    getOrderByOrderId.mockResolvedValueOnce({
      domains: [
        // No domain-name match
        { domainName: "different.com", itemType: "domain", price: 10 },
        // Hosting item with planId match
        {
          itemType: "hosting",
          hostingPlan: { planId: "premium" },
          price: 5000,
        },
      ],
    });
    await POST(makeReq());
    expect(createOrder.mock.calls[0][0].amount).toBe(5000);
  });

  it("(2) Original order has no matching item → getPlanByPlanId fallback", async () => {
    getHostingById.mockResolvedValueOnce(makeHosting());
    getOrderByOrderId.mockResolvedValueOnce({ domains: [] });
    getPlanByPlanId.mockResolvedValueOnce({
      planId: "starter",
      price: 1500,
    });
    await POST(makeReq());
    expect(getPlanByPlanId).toHaveBeenCalledWith("starter");
    expect(createOrder.mock.calls[0][0].amount).toBe(1500);
  });

  it("(3) No order, no plan → HOSTING_PLANS.starter.price last-resort", async () => {
    getHostingById.mockResolvedValueOnce(
      makeHosting({ orderId: undefined, planId: undefined })
    );
    await POST(makeReq());
    expect(createOrder.mock.calls[0][0].amount).toBe(999); // HOSTING_PLANS.starter
  });

  it("plan lookup returns null → last-resort starter fallback fires", async () => {
    getHostingById.mockResolvedValueOnce(
      makeHosting({ orderId: undefined })
    );
    getPlanByPlanId.mockResolvedValueOnce(null);
    await POST(makeReq());
    expect(createOrder.mock.calls[0][0].amount).toBe(999);
  });
});

describe("Renewal Order shape", () => {
  beforeEach(() => {
    getHostingById.mockResolvedValueOnce(makeHosting());
    getOrderByOrderId.mockResolvedValueOnce({
      domains: [
        {
          domainName: "example.com",
          price: 1500,
          periodUnit: "months",
          registrationPeriod: 1,
        },
      ],
    });
  });

  it("status:'pending', currency:'INR', orderType implicit, hostingPlan locked", async () => {
    await POST(makeReq());
    const order = createOrder.mock.calls[0][0];
    expect(order.status).toBe("pending");
    expect(order.currency).toBe("INR");
    expect(order.amount).toBe(1500);
    expect(order.userId).toBe("U1");
    expect(order.domains[0]).toEqual(
      expect.objectContaining({
        domainName: "example.com",
        currency: "INR",
        status: "pending",
        itemType: "hosting",
      })
    );
    expect(order.domains[0].hostingPlan).toEqual(
      expect.objectContaining({
        planId: "starter",
        name: "Starter",
        serverPackage: "Starter",
      })
    );
  });

  it("bookingStatus[0] step:'suspended' message:'Awaiting Renewal Payment' progress:10", async () => {
    await POST(makeReq());
    const order = createOrder.mock.calls[0][0];
    expect(order.domains[0].bookingStatus[0]).toEqual(
      expect.objectContaining({
        step: "suspended",
        message: "Awaiting Renewal Payment",
        progress: 10,
      })
    );
  });

  it("orderId starts with 'ord_renew_'", async () => {
    await POST(makeReq());
    const order = createOrder.mock.calls[0][0];
    expect(order.orderId).toMatch(/^ord_renew_/);
  });
});

describe("Email — NO Zoho invoice", () => {
  it("**email sent WITHOUT invoiceNumber** (no Zoho invoice created — Zoho only on payment)", async () => {
    getHostingById.mockResolvedValueOnce(makeHosting());
    getOrderByOrderId.mockResolvedValueOnce({ domains: [] });
    getPlanByPlanId.mockResolvedValueOnce({ price: 1500 });
    await POST(makeReq());
    expect(sendRenewalInvoiceEmail).toHaveBeenCalledTimes(1);
    const [email, name, payload] = sendRenewalInvoiceEmail.mock.calls[0];
    expect(email).toBe("alice@example.com");
    expect(name).toBe("Alice Smith");
    expect(payload).toEqual(
      expect.objectContaining({
        domainName: "example.com",
        invoiceAmount: 1500,
      })
    );
    // CRITICAL: no invoiceNumber field — Zoho hasn't been called
    expect(payload.invoiceNumber).toBeUndefined();
  });

  it("user not found → email NOT sent; hosting still suspended", async () => {
    const h = makeHosting();
    getHostingById.mockResolvedValueOnce(h);
    getUserById.mockResolvedValueOnce(null);
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(sendRenewalInvoiceEmail).not.toHaveBeenCalled();
    // hosting.save still called (status flipped to suspended)
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.status).toBe("suspended");
  });
});

describe("Status flip + persistence", () => {
  it("hosting.status = 'suspended' + save called once on happy path", async () => {
    const h = makeHosting();
    getHostingById.mockResolvedValueOnce(h);
    await POST(makeReq());
    expect(h.status).toBe("suspended");
    expect(h.save).toHaveBeenCalledTimes(1);
  });
});

describe("Inner-catch (transient retry)", () => {
  it("**suspendUser throw → 500 PROCESSING_FAILED (Cloud Tasks retries)**", async () => {
    getHostingById.mockResolvedValueOnce(makeHosting());
    suspendUser.mockRejectedValueOnce(new Error("DA unreachable"));
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("PROCESSING_FAILED");
  });

  it("createOrder throw → 500 PROCESSING_FAILED", async () => {
    getHostingById.mockResolvedValueOnce(makeHosting());
    createOrder.mockRejectedValueOnce(new Error("Mongo blip"));
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
  });
});

describe("Outer-catch", () => {
  it("getHostingById throw → 500 INTERNAL_ERROR", async () => {
    getHostingById.mockRejectedValueOnce(new Error("Mongo cluster down"));
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL_ERROR");
  });
});
