/**
 * Tests for `app/api/admin/orders/[id]/re-sync-invoice/route.ts`
 * (slice 7he, part 2). Admin manually re-runs Zoho invoice
 * creation for an order whose original sync failed. Pairs with
 * 7gt's clear-invoice-number recovery action.
 *
 * Pins:
 *  - Admin gate via getAdminFromRequest → 401
 *  - getOrderByIdOrOrderId accepts either DB _id OR orderId
 *    (caller convenience)
 *  - Order not found → 404 'Order not found'
 *  - getUserById null → 404 'Associated user not found'
 *  - **Primary-engine double-billing guard**: an order with
 *    invoiceProvider === 'primary' already holds a real GST tax
 *    invoice (TI/YYYY-YY/NNNNN) and has NO zohoInvoiceId by design.
 *    Re-syncing it would mint a SECOND invoice under the same GSTIN
 *    for one payment. Route returns 409 PRIMARY_INVOICE_EXISTS before
 *    touching Zoho. Fires BEFORE the pending_creation reset.
 *  - **Stuck-status reset**: order.zohoInvoiceId === 'pending_creation'
 *    is cleared to undefined BEFORE the Zoho retry. Pinned because
 *    without this, the retry would see the sentinel and short-
 *    circuit / fail in the same way again.
 *  - **Invoice item mapping**: each order.domains entry mapped to
 *    { itemType (default 'domain'), domainName, price,
 *    registrationPeriod (default 1), periodUnit (default by item
 *    type: months for hosting, years for domain), hostingPlan }
 *  - Zoho createInvoice called with the order/user/items/'Razorpay'/
 *    paid=true tuple
 *  - On success: order.zohoInvoiceId + order.invoiceNumber written
 *    from the Zoho response; order.save() called
 *  - Zoho null result → 500 with success:false (NOT thrown — explicit
 *    soft-failure path; admin sees the failure but the route doesn't
 *    crash)
 *  - **Outer catch leaks error.message** (matches 7gr/7gt/7gu family
 *    quirk — pinned for coordinated future hardening)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const getOrderByIdOrOrderId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({ getOrderByIdOrOrderId }));

const getUserById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserById }));

const createInvoice = vi.hoisted(() => vi.fn());
const getInstance = vi.hoisted(() => vi.fn(() => ({ createInvoice })));
vi.mock("@/lib/zohobooks", () => ({
  ZohoBooksService: { getInstance },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/admin/orders/[id]/re-sync-invoice/route";

function makeReq() {
  return new NextRequest(
    "https://example.com/api/admin/orders/ORD-1/re-sync-invoice",
    { method: "POST" }
  );
}

function paramsOf(id: string) {
  return { params: Promise.resolve({ id }) };
}

const admin = { _id: "A1", email: "admin@example.com" };
const userRow = {
  _id: "U1",
  email: "alice@example.com",
  firstName: "Alice",
  lastName: "Anderson",
};

function freshOrder(overrides: Record<string, unknown> = {}) {
  return {
    _id: "ORD_INTERNAL_ID",
    orderId: "ORD-USER-FACING",
    userId: "U1",
    amount: 1500,
    razorpayPaymentId: "pay_REAL",
    paymentId: "pay_LEGACY",
    domains: [
      {
        itemType: "domain",
        domainName: "example.com",
        price: 1500,
        registrationPeriod: 1,
        periodUnit: "years",
      },
    ],
    zohoInvoiceId: undefined,
    invoiceNumber: undefined,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  getAdminFromRequest.mockReset().mockResolvedValue(admin);
  getOrderByIdOrOrderId.mockReset();
  getUserById.mockReset();
  createInvoice.mockReset();
});

describe("Admin gate", () => {
  it("non-admin → 401; NO order lookup", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(401);
    expect(getOrderByIdOrOrderId).not.toHaveBeenCalled();
  });
});

describe("Order + user lookup", () => {
  it("getOrderByIdOrOrderId called with the route id (accepts _id OR orderId)", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(null);
    await POST(makeReq(), paramsOf("ORD-USER-FACING"));
    expect(getOrderByIdOrOrderId).toHaveBeenCalledWith("ORD-USER-FACING");
  });

  it("order not found → 404 'Order not found'", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(null);
    const res = await POST(makeReq(), paramsOf("ORD-MISSING"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Order not found");
    expect(getUserById).not.toHaveBeenCalled();
  });

  it("getUserById null → 404 'Associated user not found'", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(freshOrder());
    getUserById.mockResolvedValueOnce(null);
    const res = await POST(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Associated user not found");
    expect(createInvoice).not.toHaveBeenCalled();
  });
});

describe("Primary-engine double-billing guard", () => {
  it("invoiceProvider === 'primary' → 409, Zoho NEVER called, order NOT saved", async () => {
    const order = freshOrder({
      invoiceProvider: "primary",
      invoiceNumber: "TI/2026-27/00001",
      zohoInvoiceId: undefined,
    });
    getOrderByIdOrOrderId.mockResolvedValueOnce(order);
    getUserById.mockResolvedValueOnce(userRow);

    const res = await POST(makeReq(), paramsOf("ORD-1"));

    expect(res.status).toBe(409);
    // The whole point: no second tax invoice under the same GSTIN.
    expect(createInvoice).not.toHaveBeenCalled();
    expect(order.save).not.toHaveBeenCalled();
    expect(order.zohoInvoiceId).toBeUndefined();
    expect(order.invoiceNumber).toBe("TI/2026-27/00001");
  });

  it("409 body carries the machine code + the primary invoice number", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(
      freshOrder({
        invoiceProvider: "primary",
        invoiceNumber: "TI/2026-27/00042",
      })
    );
    getUserById.mockResolvedValueOnce(userRow);

    const res = await POST(makeReq(), paramsOf("ORD-1"));
    const body = await res.json();

    expect(body.code).toBe("PRIMARY_INVOICE_EXISTS");
    expect(body.invoiceProvider).toBe("primary");
    expect(body.invoice_number).toBe("TI/2026-27/00042");
    // Admin toast renders `error` — it must name the order and the number.
    expect(body.error).toContain("ORD-USER-FACING");
    expect(body.error).toContain("TI/2026-27/00042");
    expect(body.error).toContain("not a stuck order");
  });

  it("guard fires even when invoiceNumber is missing (no crash, no Zoho call)", async () => {
    const order = freshOrder({
      invoiceProvider: "primary",
      invoiceNumber: undefined,
    });
    getOrderByIdOrOrderId.mockResolvedValueOnce(order);
    getUserById.mockResolvedValueOnce(userRow);

    const res = await POST(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(409);
    expect(createInvoice).not.toHaveBeenCalled();
    const body = await res.json();
    // No trailing "( )" fragment when there's no number to name.
    expect(body.error).not.toContain("()");
  });

  it("guard fires BEFORE the 'pending_creation' reset — a primary order carrying a stale sentinel is still refused", async () => {
    const order = freshOrder({
      invoiceProvider: "primary",
      invoiceNumber: "TI/2026-27/00007",
      zohoInvoiceId: "pending_creation",
    });
    getOrderByIdOrOrderId.mockResolvedValueOnce(order);
    getUserById.mockResolvedValueOnce(userRow);

    const res = await POST(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(409);
    expect(createInvoice).not.toHaveBeenCalled();
    // The sentinel is left untouched — the guard returns before the reset.
    expect(order.zohoInvoiceId).toBe("pending_creation");
  });

  it("invoiceProvider === 'zoho' is NOT guarded — a genuinely stuck Zoho order still re-syncs", async () => {
    const order = freshOrder({
      invoiceProvider: "zoho",
      zohoInvoiceId: "creation_failed",
    });
    getOrderByIdOrOrderId.mockResolvedValueOnce(order);
    getUserById.mockResolvedValueOnce(userRow);
    createInvoice.mockResolvedValueOnce({
      invoice_id: "zoho-recovered",
      invoice_number: "INV-RECOVERED",
    });

    const res = await POST(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(200);
    expect(createInvoice).toHaveBeenCalledTimes(1);
    expect(order.zohoInvoiceId).toBe("zoho-recovered");
  });

  it("legacy order with NO invoiceProvider is NOT guarded (pre-primary rows still recoverable)", async () => {
    const order = freshOrder({ invoiceProvider: undefined });
    getOrderByIdOrOrderId.mockResolvedValueOnce(order);
    getUserById.mockResolvedValueOnce(userRow);
    createInvoice.mockResolvedValueOnce({
      invoice_id: "zoho-legacy",
      invoice_number: "INV-LEGACY",
    });

    const res = await POST(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(200);
    expect(createInvoice).toHaveBeenCalledTimes(1);
  });
});

describe("Stuck-status reset", () => {
  it("zohoInvoiceId === 'pending_creation' → cleared to undefined BEFORE Zoho retry", async () => {
    const order = freshOrder({ zohoInvoiceId: "pending_creation" });
    const captured: { zohoInvoiceIdAtRetry?: unknown } = {};
    getOrderByIdOrOrderId.mockResolvedValueOnce(order);
    getUserById.mockResolvedValueOnce(userRow);
    createInvoice.mockImplementationOnce(() => {
      // Capture the value AT THE TIME of the Zoho call (after the reset,
      // before the post-success write)
      captured.zohoInvoiceIdAtRetry = order.zohoInvoiceId;
      return Promise.resolve({
        invoice_id: "zoho-new",
        invoice_number: "INV-NEW",
      });
    });

    await POST(makeReq(), paramsOf("ORD-1"));
    // The route's implementation order:
    //   1. clear 'pending_creation' → undefined
    //   2. call Zoho.createInvoice (at this point: undefined captured)
    //   3. write the success result back → 'zoho-new'
    // So mid-call we should see undefined (NOT the stale sentinel),
    // and post-call we should see the new id.
    expect(captured.zohoInvoiceIdAtRetry).toBeUndefined();
    expect(order.zohoInvoiceId).toBe("zoho-new");
    expect(order.zohoInvoiceId).not.toBe("pending_creation");
  });

  it("non-sentinel zohoInvoiceId left alone if already real (e.g. mid-recovery re-sync)", async () => {
    const order = freshOrder({ zohoInvoiceId: "zoho-existing-real-id" });
    getOrderByIdOrOrderId.mockResolvedValueOnce(order);
    getUserById.mockResolvedValueOnce(userRow);
    createInvoice.mockResolvedValueOnce({
      invoice_id: "zoho-replacement",
      invoice_number: "INV-NEW",
    });

    await POST(makeReq(), paramsOf("ORD-1"));
    // Existing real id was NOT cleared mid-flight (only sentinels are);
    // it ends up overwritten by the Zoho response on success.
    expect(order.zohoInvoiceId).toBe("zoho-replacement");
  });
});

describe("Invoice item mapping (defaults for missing fields)", () => {
  it("missing itemType / registrationPeriod / periodUnit → defaults applied", async () => {
    const order = freshOrder({
      domains: [
        {
          // No itemType → defaults to 'domain'
          domainName: "default-defaults.com",
          price: 999,
          // No registrationPeriod → defaults to 1
          // No periodUnit → defaults to 'years' (because not hosting)
        },
        {
          itemType: "hosting",
          domainName: "host.com",
          price: 1500,
          // No periodUnit → defaults to 'months' (because hosting)
        },
      ],
    });
    getOrderByIdOrOrderId.mockResolvedValueOnce(order);
    getUserById.mockResolvedValueOnce(userRow);
    createInvoice.mockResolvedValueOnce({
      invoice_id: "zoho-1",
      invoice_number: "INV-1",
    });

    await POST(makeReq(), paramsOf("ORD-1"));

    expect(createInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "ORD-USER-FACING" }),
      userRow,
      [
        expect.objectContaining({
          itemType: "domain",
          domainName: "default-defaults.com",
          price: 999,
          registrationPeriod: 1,
          periodUnit: "years",
        }),
        expect.objectContaining({
          itemType: "hosting",
          domainName: "host.com",
          price: 1500,
          periodUnit: "months",
        }),
      ],
      "Razorpay",
      true
    );
  });
});

describe("Happy path — Zoho success", () => {
  it("on success: order.zohoInvoiceId + order.invoiceNumber written from Zoho; order.save() called; response carries the IDs", async () => {
    const order = freshOrder();
    getOrderByIdOrOrderId.mockResolvedValueOnce(order);
    getUserById.mockResolvedValueOnce(userRow);
    createInvoice.mockResolvedValueOnce({
      invoice_id: "zoho-new-id",
      invoice_number: "INV-2026-00099",
    });

    const res = await POST(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(200);

    expect(order.zohoInvoiceId).toBe("zoho-new-id");
    expect(order.invoiceNumber).toBe("INV-2026-00099");
    expect(order.save).toHaveBeenCalledTimes(1);

    const body = await res.json();
    expect(body).toEqual({
      success: true,
      message: "Invoice successfully synced with Zoho Books",
      invoice_id: "zoho-new-id",
      invoice_number: "INV-2026-00099",
    });
  });

  it("razorpayPaymentId preferred over paymentId in Zoho call payload", async () => {
    const order = freshOrder({
      razorpayPaymentId: "pay_RAZORPAY_PREFERRED",
      paymentId: "pay_LEGACY",
    });
    getOrderByIdOrOrderId.mockResolvedValueOnce(order);
    getUserById.mockResolvedValueOnce(userRow);
    createInvoice.mockResolvedValueOnce({
      invoice_id: "Z1",
      invoice_number: "INV-1",
    });

    await POST(makeReq(), paramsOf("ORD-1"));
    expect(createInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        razorpayPaymentId: "pay_RAZORPAY_PREFERRED",
      }),
      userRow,
      expect.any(Array),
      "Razorpay",
      true
    );
  });

  it("falls back to paymentId when razorpayPaymentId missing", async () => {
    const order = freshOrder({
      razorpayPaymentId: undefined,
      paymentId: "pay_LEGACY",
    });
    getOrderByIdOrOrderId.mockResolvedValueOnce(order);
    getUserById.mockResolvedValueOnce(userRow);
    createInvoice.mockResolvedValueOnce({
      invoice_id: "Z1",
      invoice_number: "INV-1",
    });

    await POST(makeReq(), paramsOf("ORD-1"));
    expect(createInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ razorpayPaymentId: "pay_LEGACY" }),
      userRow,
      expect.any(Array),
      "Razorpay",
      true
    );
  });
});

describe("Zoho soft-failure (null result, no throw)", () => {
  it("null or no invoice_id → 500 with success:false; order NOT saved", async () => {
    const order = freshOrder();
    getOrderByIdOrOrderId.mockResolvedValueOnce(order);
    getUserById.mockResolvedValueOnce(userRow);
    createInvoice.mockResolvedValueOnce(null);

    const res = await POST(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.message).toContain("Failed to generate invoice");
    expect(order.save).not.toHaveBeenCalled();
  });

  it("result object missing invoice_id → 500 soft-failure", async () => {
    const order = freshOrder();
    getOrderByIdOrOrderId.mockResolvedValueOnce(order);
    getUserById.mockResolvedValueOnce(userRow);
    createInvoice.mockResolvedValueOnce({ invoice_number: "no-id" });

    const res = await POST(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(order.save).not.toHaveBeenCalled();
  });
});

describe("Outer catch — error.message leak (matches 7gr/7gt family)", () => {
  it("Error throw → 500 with raw err.message (pinned alongside the family for coordinated hardening)", async () => {
    getOrderByIdOrOrderId.mockRejectedValueOnce(
      new Error("Mongo write conflict: shard-2 timeout")
    );
    const res = await POST(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Mongo write conflict: shard-2 timeout");
  });

  it("Zoho throw → 500 with raw err.message", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(freshOrder());
    getUserById.mockResolvedValueOnce(userRow);
    createInvoice.mockRejectedValueOnce(new Error("Zoho 503"));
    const res = await POST(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Zoho 503");
  });
});
