/**
 * Tests for `app/api/admin/pending-domains/[id]/register/route.ts`
 * (slice 7i7, part 2).
 *
 * Admin "manually register this pending domain" — fires the ResellerClub
 * call, updates the linked Order, sends order-confirmation email if
 * all domains complete, triggers Zoho invoice sync.
 *
 * Threat model:
 *  - **Double-register from concurrent admin clicks**: a refactor
 *    that fired the RC call BEFORE flipping the status to
 *    'processing' would let two admin tabs both fire registerDomain
 *    on the same row. Pinned: status flip happens first.
 *  - **Already-completed re-register**: a refactor that didn't gate
 *    on status='pending' would let admin re-fire on a row that
 *    already completed (or failed/processing). Pinned 400.
 *  - **Zoho-invoice duplicate**: idempotency — skip Zoho sync when
 *    zohoInvoiceId is already set OR is 'pending_creation'. Pinned.
 *
 * Other pins:
 *  - admin gate → 401
 *  - PendingDomain.findById null → 404
 *  - status !== 'pending' → 400
 *  - status='processing' set + saved BEFORE the RC call
 *  - RC registerDomain contacts fallback chain:
 *      admin: adminContactId ?? contactId
 *      tech: techContactId ?? contactId
 *      billing: billingContactId ?? contactId
 *  - RC status='success':
 *      pendingDomain status='completed', registeredAt=now,
 *        expiresAt = now + period × 365 × 86_400_000,
 *        resellerClubOrderId=result.data.orderid
 *      Order domain entry updated to status='registered' with
 *        resellerClubOrderId + expiresAt + registeredAt
 *      ALL domains registered → sendOrderConfirmationEmail with
 *        subtotal = amount/1.18
 *      ALL domains NOT registered → email NOT sent
 *      Zoho sync: createInvoice ONLY when zohoInvoiceId absent
 *        or 'pending_creation' (idempotent)
 *      Zoho sync uses paymentMode='Razorpay', shouldApplyPayment=true
 *      Returns 200 success
 *  - RC status='error' (not throw):
 *      pendingDomain status='failed' + reason=`Registration failed: ${msg}`
 *      Order domain entry updated to status='failed' + error message
 *      Returns 400 with the RC error message
 *  - RC throw:
 *      pendingDomain status='failed' + reason=`Registration error: ${msg}`
 *      Returns 500
 *  - Outer catch (e.g. connectDB throw) → 500 INTERNAL_ERROR
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const findById = vi.hoisted(() => vi.fn());
vi.mock("@/models/PendingDomain", () => ({
  default: { findById },
}));

const getOrderByOrderId = vi.hoisted(() => vi.fn());
const recordZohoInvoiceForOrder = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  getOrderByOrderId,
  recordZohoInvoiceForOrder,
}));

const getUserById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserById }));

const registerDomain = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub-wrapper", () => ({
  ResellerClubWrapper: { registerDomain },
}));

vi.mock("@/lib/domain-verification", () => ({
  DomainVerificationService: {},
}));

const sendOrderConfirmationEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  EmailService: { sendOrderConfirmationEmail },
}));

const createInvoice = vi.hoisted(() => vi.fn());
vi.mock("@/lib/zohobooks", () => ({
  ZohoBooksService: {
    getInstance: () => ({ createInvoice }),
  },
}));

vi.mock("@/lib/mongodb", () => ({
  default: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/admin/pending-domains/[id]/register/route";

const PD_ID = "P1";

function makeReq() {
  return new NextRequest(
    `https://example.com/api/admin/pending-domains/${PD_ID}/register`,
    { method: "POST" }
  );
}

const params = { params: Promise.resolve({ id: PD_ID }) };

interface FakePendingDomain {
  _id: string;
  domainName: string;
  registrationPeriod: number;
  customerId: string;
  nameServers: string[];
  adminContactId?: string;
  techContactId?: string;
  billingContactId?: string;
  contactId: string;
  tldAttributes: Record<string, unknown>;
  status: string;
  orderId: string;
  userId: string;
  reason?: string;
  registeredAt?: Date;
  expiresAt?: Date;
  resellerClubOrderId?: string;
  save: ReturnType<typeof vi.fn>;
}

function makePendingDomain(
  overrides: Partial<FakePendingDomain> = {}
): FakePendingDomain {
  return {
    _id: PD_ID,
    domainName: "example.com",
    registrationPeriod: 1,
    customerId: "C1",
    nameServers: ["ns1.example.com"],
    adminContactId: undefined,
    techContactId: undefined,
    billingContactId: undefined,
    contactId: "K1",
    tldAttributes: {},
    status: "pending",
    orderId: "ORD-1",
    userId: "U1",
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeOrder(domains: Array<Record<string, unknown>> = []) {
  return {
    _id: "OBJ-O1",
    orderId: "ORD-1",
    amount: 1180,
    currency: "INR",
    paymentId: "pay_x",
    razorpayPaymentId: "rzp_x",
    purchaseOrderNumber: "",
    invoiceNumber: "",
    zohoInvoiceId: undefined as string | undefined,
    createdAt: new Date("2026-06-01"),
    domains,
    userId: {
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Smith",
    },
    save: vi.fn().mockResolvedValue(undefined),
    markModified: vi.fn(),
  };
}

beforeEach(() => {
  getAdminFromRequest.mockReset().mockResolvedValue({ _id: "ADMIN1" });
  findById.mockReset();
  getOrderByOrderId.mockReset();
  recordZohoInvoiceForOrder.mockReset().mockResolvedValue(undefined);
  getUserById.mockReset();
  registerDomain.mockReset();
  sendOrderConfirmationEmail.mockReset().mockResolvedValue(undefined);
  createInvoice.mockReset();
});

describe("Admin gate + not-found", () => {
  it("non-admin → 401", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(401);
  });

  it("pendingDomain not found → 404", async () => {
    findById.mockResolvedValueOnce(null);
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(404);
  });
});

describe("Status guard — anti-double-register", () => {
  it("status='processing' → 400 (already in flight)", async () => {
    findById.mockResolvedValueOnce(makePendingDomain({ status: "processing" }));
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(400);
    expect(registerDomain).not.toHaveBeenCalled();
  });

  it("status='completed' → 400 (already done)", async () => {
    findById.mockResolvedValueOnce(makePendingDomain({ status: "completed" }));
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(400);
  });

  it("status='failed' → 400 (failed already; needs different reset)", async () => {
    findById.mockResolvedValueOnce(makePendingDomain({ status: "failed" }));
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(400);
  });

  it("**status='pending' → status flipped to 'processing' BEFORE RC call** (anti-double-fire)", async () => {
    const pd = makePendingDomain();
    findById.mockResolvedValueOnce(pd);
    // Capture status at the moment RC is invoked
    let statusAtRcCall: string | undefined;
    registerDomain.mockImplementation(async () => {
      statusAtRcCall = pd.status;
      return { status: "success", data: { orderid: "RC-1" } };
    });
    getOrderByOrderId.mockResolvedValue(null);
    await POST(makeReq(), params);
    expect(statusAtRcCall).toBe("processing");
  });
});

describe("RC contacts fallback chain", () => {
  it("admin/tech/billing-ContactId all undefined → all fall back to contactId", async () => {
    findById.mockResolvedValueOnce(
      makePendingDomain({
        contactId: "K_ROOT",
        adminContactId: undefined,
        techContactId: undefined,
        billingContactId: undefined,
      })
    );
    registerDomain.mockResolvedValueOnce({ status: "error", message: "x" });
    getOrderByOrderId.mockResolvedValue(null);
    await POST(makeReq(), params);
    const contacts = registerDomain.mock.calls[0][4];
    expect(contacts).toEqual({
      admin: "K_ROOT",
      tech: "K_ROOT",
      billing: "K_ROOT",
    });
  });

  it("specific contact IDs override the fallback", async () => {
    findById.mockResolvedValueOnce(
      makePendingDomain({
        contactId: "K_ROOT",
        adminContactId: "K_ADMIN",
        techContactId: "K_TECH",
        billingContactId: "K_BILL",
      })
    );
    registerDomain.mockResolvedValueOnce({ status: "error", message: "x" });
    getOrderByOrderId.mockResolvedValue(null);
    await POST(makeReq(), params);
    const contacts = registerDomain.mock.calls[0][4];
    expect(contacts).toEqual({
      admin: "K_ADMIN",
      tech: "K_TECH",
      billing: "K_BILL",
    });
  });
});

describe("Success branch", () => {
  beforeEach(() => {
    registerDomain.mockResolvedValue({
      status: "success",
      data: { orderid: "RC-789" },
    });
  });

  it("pendingDomain marked completed with expiresAt = now + period × 365 × 86400000", async () => {
    const pd = makePendingDomain({ registrationPeriod: 2 });
    findById.mockResolvedValueOnce(pd);
    getOrderByOrderId.mockResolvedValue(null);
    const before = Date.now();
    await POST(makeReq(), params);
    expect(pd.status).toBe("completed");
    expect(pd.resellerClubOrderId).toBe("RC-789");
    expect(pd.registeredAt).toBeInstanceOf(Date);
    const expiry = (pd.expiresAt as Date).getTime();
    expect(expiry).toBeGreaterThanOrEqual(
      before + 2 * 365 * 24 * 60 * 60 * 1000 - 5000
    );
    expect(expiry).toBeLessThanOrEqual(
      Date.now() + 2 * 365 * 24 * 60 * 60 * 1000 + 5000
    );
  });

  it("order's domain entry updated to status='registered' + RC orderId + expiresAt + registeredAt", async () => {
    findById.mockResolvedValueOnce(makePendingDomain());
    const order = makeOrder([
      { domainName: "example.com", status: "pending" },
    ]);
    getOrderByOrderId.mockResolvedValueOnce(order);
    await POST(makeReq(), params);
    expect(order.domains[0].status).toBe("registered");
    expect(order.domains[0].resellerClubOrderId).toBe("RC-789");
    expect(order.domains[0].expiresAt).toBeInstanceOf(Date);
    expect(order.save).toHaveBeenCalled();
  });

  it("ALL domains registered → sendOrderConfirmationEmail called with subtotal = amount/1.18", async () => {
    findById.mockResolvedValueOnce(makePendingDomain());
    const order = makeOrder([
      { domainName: "example.com", status: "pending", price: 1000, registrationPeriod: 1 },
    ]);
    order.amount = 1180; // GST included
    getOrderByOrderId.mockResolvedValueOnce(order); // first call
    getOrderByOrderId.mockResolvedValueOnce(order); // zoho-sync second fetch
    getUserById.mockResolvedValueOnce({
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Smith",
    });
    createInvoice.mockResolvedValueOnce(null); // skip zoho writes
    await POST(makeReq(), params);
    expect(sendOrderConfirmationEmail).toHaveBeenCalledTimes(1);
    const arg = sendOrderConfirmationEmail.mock.calls[0][2];
    // 1180 / 1.18 = 1000
    expect(arg.subtotal).toBeCloseTo(1000, 5);
  });

  it("NOT all domains registered → email NOT sent", async () => {
    findById.mockResolvedValueOnce(makePendingDomain());
    const order = makeOrder([
      { domainName: "example.com", status: "pending" },
      { domainName: "other.com", status: "pending" }, // still pending
    ]);
    getOrderByOrderId.mockResolvedValueOnce(order);
    getOrderByOrderId.mockResolvedValueOnce(order);
    getUserById.mockResolvedValueOnce({ email: "x@y.com", firstName: "X", lastName: "Y" });
    createInvoice.mockResolvedValueOnce(null);
    await POST(makeReq(), params);
    expect(sendOrderConfirmationEmail).not.toHaveBeenCalled();
  });
});

describe("Zoho-invoice idempotency", () => {
  beforeEach(() => {
    registerDomain.mockResolvedValue({
      status: "success",
      data: { orderid: "RC-789" },
    });
  });

  it("**existing zohoInvoiceId (real value) → createInvoice NOT called** (idempotent)", async () => {
    findById.mockResolvedValueOnce(makePendingDomain());
    const orderWithInvoice = {
      ...makeOrder([{ domainName: "example.com", status: "pending" }]),
      zohoInvoiceId: "INV-EXISTING",
    };
    getOrderByOrderId.mockResolvedValueOnce(orderWithInvoice);
    getOrderByOrderId.mockResolvedValueOnce(orderWithInvoice);
    getUserById.mockResolvedValueOnce({
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Smith",
    });
    await POST(makeReq(), params);
    expect(createInvoice).not.toHaveBeenCalled();
  });

  it("zohoInvoiceId === 'pending_creation' → createInvoice called (treated as unset)", async () => {
    findById.mockResolvedValueOnce(makePendingDomain());
    const order = {
      ...makeOrder([{ domainName: "example.com", status: "pending" }]),
      zohoInvoiceId: "pending_creation",
    };
    getOrderByOrderId.mockResolvedValueOnce(order);
    getOrderByOrderId.mockResolvedValueOnce(order);
    getUserById.mockResolvedValueOnce({
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Smith",
    });
    createInvoice.mockResolvedValueOnce({
      invoice_id: "INV-NEW",
      invoice_number: "INV-001",
    });
    await POST(makeReq(), params);
    expect(createInvoice).toHaveBeenCalledTimes(1);
    expect(createInvoice.mock.calls[0][3]).toBe("Razorpay");
    expect(createInvoice.mock.calls[0][4]).toBe(true);
    expect(recordZohoInvoiceForOrder).toHaveBeenCalledWith(
      "OBJ-O1",
      expect.objectContaining({
        invoiceId: "INV-NEW",
        invoiceNumber: "INV-001",
      })
    );
  });

  it("Zoho createInvoice throw → SWALLOWED (response still 200 success)", async () => {
    findById.mockResolvedValueOnce(makePendingDomain());
    const order = makeOrder([{ domainName: "example.com", status: "pending" }]);
    getOrderByOrderId.mockResolvedValueOnce(order);
    getOrderByOrderId.mockResolvedValueOnce(order);
    getUserById.mockResolvedValueOnce({
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Smith",
    });
    createInvoice.mockRejectedValueOnce(new Error("Zoho down"));
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(200);
  });
});

describe("Failure branch (RC status='error', not throw)", () => {
  it("pendingDomain marked failed + reason; order's domain updated", async () => {
    const pd = makePendingDomain();
    findById.mockResolvedValueOnce(pd);
    registerDomain.mockResolvedValueOnce({
      status: "error",
      message: "Domain already registered",
    });
    const order = makeOrder([{ domainName: "example.com", status: "processing" }]);
    getOrderByOrderId.mockResolvedValueOnce(order);
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(400);
    expect(pd.status).toBe("failed");
    expect(pd.reason).toContain("Domain already registered");
    expect(order.domains[0].status).toBe("failed");
    expect(order.domains[0].error).toContain("Domain already registered");
    expect(order.markModified).toHaveBeenCalledWith("domains");
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});

describe("Failure branch (RC throw)", () => {
  it("pendingDomain marked failed + reason; 500 returned", async () => {
    const pd = makePendingDomain();
    findById.mockResolvedValueOnce(pd);
    registerDomain.mockRejectedValueOnce(new Error("ECONNREFUSED rc"));
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(500);
    expect(pd.status).toBe("failed");
    expect(pd.reason).toContain("Registration error");
    expect(pd.reason).toContain("ECONNREFUSED");
  });
});

describe("Outer catch", () => {
  it("findById throw (e.g. Mongo down) → 500 INTERNAL_ERROR", async () => {
    findById.mockRejectedValueOnce(new Error("Mongo cluster down"));
    const res = await POST(makeReq(), params);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
  });
});
