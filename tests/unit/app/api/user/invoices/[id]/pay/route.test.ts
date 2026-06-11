/**
 * Tests for `app/api/user/invoices/[id]/pay/route.ts` (slice 7he,
 * part 1). Customer initiates payment for an existing Zoho
 * invoice (renewal flow). Returns a Razorpay order id the
 * front-end uses to open the payment widget.
 *
 * Threat model:
 *  - **Cross-tenant invoice access**: invoice id comes from the
 *    URL. Without an ownership check, any logged-in user could
 *    enumerate Zoho invoice IDs and pay (or peek at) another
 *    tenant's invoice.
 *  - **Double-pay**: a paid invoice (balance:0) must not be re-
 *    payable.
 *
 * Pins:
 *  - Auth → 401
 *  - Missing :id → 400 'Invoice ID is required'
 *  - **IDOR via findOrderByZohoInvoiceForUser(user._id, id,
 *    {select:'_id zohoInvoiceId'})** — minimal projection pinned;
 *    runs BEFORE any Zoho/Razorpay call
 *  - **Non-owner → 404 'Invoice not found' (NOT 403)** — pinned
 *    deliberately: identical response to "invoice doesn't exist"
 *    case to avoid leaking whether the id belongs to another
 *    user. A security-warn log line records the attempt.
 *  - Zoho getInvoiceById null → 404
 *  - **Balance gate**: invoice.balance ≤ 0 → 400 'Invoice is
 *    already paid' (NO Razorpay call — anti-double-pay)
 *  - **Receipt id shape**: `rnw_${invoiceId}_${Date.now()}`
 *  - Razorpay createOrder call shape: (balance, currency_code OR
 *    'INR', receiptId, notes:{type, invoice_id, user_id, email})
 *  - Currency defaults to 'INR' when invoice.currency_code missing
 *  - Outer catch → 500 'Failed to initiate payment' generic
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const findOrderByZohoInvoiceForUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({ findOrderByZohoInvoiceForUser }));

const createOrder = vi.hoisted(() => vi.fn());
vi.mock("@/lib/razorpay", () => ({
  RazorpayService: { createOrder },
}));

const getInvoiceById = vi.hoisted(() => vi.fn());
const getInstance = vi.hoisted(() => vi.fn(() => ({ getInvoiceById })));
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

import { POST } from "@/app/api/user/invoices/[id]/pay/route";

function makeReq() {
  return new NextRequest("https://example.com/api/user/invoices/INV-1/pay", {
    method: "POST",
  });
}

function paramsOf(id: string) {
  return { params: Promise.resolve({ id }) };
}

const user = { _id: "U1", id: "U1", email: "alice@example.com" };

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(user);
  findOrderByZohoInvoiceForUser.mockReset();
  createOrder.mockReset();
  getInvoiceById.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Auth gate", () => {
  it("no user → 401; NO further work", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makeReq(), paramsOf("INV-1"));
    expect(res.status).toBe(401);
    expect(findOrderByZohoInvoiceForUser).not.toHaveBeenCalled();
  });
});

describe("Missing-id guard", () => {
  it("empty id → 400 'Invoice ID is required'", async () => {
    const res = await POST(makeReq(), paramsOf(""));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invoice ID is required");
    expect(findOrderByZohoInvoiceForUser).not.toHaveBeenCalled();
  });
});

describe("IDOR via MongoDB BEFORE Zoho/Razorpay", () => {
  it("findOrderByZohoInvoiceForUser called with (user._id, id, {select:'_id zohoInvoiceId'}) — minimal projection", async () => {
    findOrderByZohoInvoiceForUser.mockResolvedValueOnce(null);
    await POST(makeReq(), paramsOf("INV-OTHER"));
    expect(findOrderByZohoInvoiceForUser).toHaveBeenCalledWith(
      "U1",
      "INV-OTHER",
      { select: "_id zohoInvoiceId" }
    );
  });

  it("**Non-owner → 404 'Invoice not found' (NOT 403)** — anti-enumeration; same response as missing invoice", async () => {
    findOrderByZohoInvoiceForUser.mockResolvedValueOnce(null);
    const res = await POST(makeReq(), paramsOf("INV-OTHER"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Invoice not found");
    expect(getInvoiceById).not.toHaveBeenCalled();
    expect(createOrder).not.toHaveBeenCalled();
  });
});

describe("Zoho lookup", () => {
  it("getInvoiceById null → 404 (same shape as non-owner — pinned deliberate parity)", async () => {
    findOrderByZohoInvoiceForUser.mockResolvedValueOnce({ _id: "O1" });
    getInvoiceById.mockResolvedValueOnce(null);
    const res = await POST(makeReq(), paramsOf("INV-1"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Invoice not found");
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("getInvoiceById called with the URL invoice id", async () => {
    findOrderByZohoInvoiceForUser.mockResolvedValueOnce({ _id: "O1" });
    getInvoiceById.mockResolvedValueOnce({
      balance: 999,
      currency_code: "INR",
      invoice_number: "INV-2026-00001",
    });
    createOrder.mockResolvedValueOnce({ id: "order_RZP_1" });
    await POST(makeReq(), paramsOf("INV-XYZ"));
    expect(getInvoiceById).toHaveBeenCalledWith("INV-XYZ");
  });
});

describe("Balance gate (anti-double-pay)", () => {
  it("balance === 0 → 400 'Invoice is already paid'; NO Razorpay call", async () => {
    findOrderByZohoInvoiceForUser.mockResolvedValueOnce({ _id: "O1" });
    getInvoiceById.mockResolvedValueOnce({ balance: 0 });
    const res = await POST(makeReq(), paramsOf("INV-1"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invoice is already paid");
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("balance < 0 (refund / credit balance) → 400 'Invoice is already paid'", async () => {
    findOrderByZohoInvoiceForUser.mockResolvedValueOnce({ _id: "O1" });
    getInvoiceById.mockResolvedValueOnce({ balance: -10 });
    const res = await POST(makeReq(), paramsOf("INV-1"));
    expect(res.status).toBe(400);
    expect(createOrder).not.toHaveBeenCalled();
  });
});

describe("Receipt id + Razorpay createOrder shape", () => {
  it("receipt id is `rnw_${invoiceId}_${Date.now()}`", async () => {
    const NOW = 1717999999999;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));

    findOrderByZohoInvoiceForUser.mockResolvedValueOnce({ _id: "O1" });
    getInvoiceById.mockResolvedValueOnce({
      balance: 999,
      currency_code: "INR",
      invoice_number: "INV-2026-00001",
    });
    createOrder.mockResolvedValueOnce({ id: "order_RZP_FAKE" });

    await POST(makeReq(), paramsOf("INV-7"));
    expect(createOrder).toHaveBeenCalledWith(
      999,
      "INR",
      `rnw_INV-7_${NOW}`,
      expect.objectContaining({
        type: "invoice_payment",
        invoice_id: "INV-7",
        user_id: "U1",
        email: "alice@example.com",
      })
    );
  });

  it("currency_code defaults to 'INR' when missing on the invoice", async () => {
    findOrderByZohoInvoiceForUser.mockResolvedValueOnce({ _id: "O1" });
    getInvoiceById.mockResolvedValueOnce({
      balance: 100,
      // No currency_code
      invoice_number: "INV-2026-00002",
    });
    createOrder.mockResolvedValueOnce({ id: "order_RZP_2" });

    await POST(makeReq(), paramsOf("INV-2"));
    expect(createOrder).toHaveBeenCalledWith(
      100,
      "INR",
      expect.any(String),
      expect.any(Object)
    );
  });
});

describe("Happy path response shape", () => {
  it("returns {success, razorpayOrderId, amount, currency, invoiceNumber, orderId}", async () => {
    const NOW = 1717111111111;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));

    findOrderByZohoInvoiceForUser.mockResolvedValueOnce({ _id: "O1" });
    getInvoiceById.mockResolvedValueOnce({
      balance: 1500,
      currency_code: "USD",
      invoice_number: "INV-2026-00077",
    });
    createOrder.mockResolvedValueOnce({ id: "order_RZP_HAPPY" });

    const res = await POST(makeReq(), paramsOf("INV-77"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      razorpayOrderId: "order_RZP_HAPPY",
      amount: 1500,
      currency: "USD",
      invoiceNumber: "INV-2026-00077",
      orderId: `rnw_INV-77_${NOW}`,
    });
  });
});

describe("Outer catch", () => {
  it("Razorpay throw → 500 'Failed to initiate payment' (no leak)", async () => {
    findOrderByZohoInvoiceForUser.mockResolvedValueOnce({ _id: "O1" });
    getInvoiceById.mockResolvedValueOnce({
      balance: 100,
      currency_code: "INR",
      invoice_number: "INV-2",
    });
    createOrder.mockRejectedValueOnce(
      new Error("Razorpay: key_id=rzp_test_LEAK invalid")
    );
    const res = await POST(makeReq(), paramsOf("INV-2"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to initiate payment");
    expect(body.error).not.toContain("rzp_test_LEAK");
    expect(body.error).not.toContain("key_id");
  });

  it("Zoho throw → 500 'Failed to initiate payment'", async () => {
    findOrderByZohoInvoiceForUser.mockResolvedValueOnce({ _id: "O1" });
    getInvoiceById.mockRejectedValueOnce(new Error("Zoho 401"));
    const res = await POST(makeReq(), paramsOf("INV-1"));
    expect(res.status).toBe(500);
  });
});
