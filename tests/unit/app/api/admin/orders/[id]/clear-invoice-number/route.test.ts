/**
 * Tests for `app/api/admin/orders/[id]/clear-invoice-number/route.ts`
 * (slice 7gt, part 2). Admin-only collision-recovery action. Unsets
 * the `invoiceNumber` field on a specific Order so the unique-index
 * value is freed.
 *
 * Pins:
 *  - Admin gate via getAdminFromRequest → 401 (NOT 403; matches the
 *    other admin-orders endpoints — same module family)
 *  - getOrderByIdOrOrderId(id, { select:'_id orderId invoiceNumber' })
 *    — field selection pinned so the route never pulls the full
 *    Order document (this admin tool should not see payment
 *    details / personal data)
 *  - not found → 404 'Order not found'
 *  - **Idempotent no-op**: order has no invoiceNumber → 200 with
 *    'Order already has no invoiceNumber' AND clearOrderInvoiceNumber
 *    NOT called (calling again on a cleared order doesn't error)
 *  - Happy path: invoiceNumber present →
 *    clearOrderInvoiceNumber(order._id) (not the param id);
 *    response includes previousInvoiceNumber + the user-facing
 *    "the value is now free" message
 *  - **Error-leak pinned**: outer catch with Error instance →
 *    500 with raw err.message. Pinned alongside the 7gr / 7go
 *    pending-hosting family quirk for the coordinated hardening
 *    pass.
 *  - Non-Error throw → 'Action failed' fallback
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const clearOrderInvoiceNumber = vi.hoisted(() => vi.fn());
const getOrderByIdOrOrderId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  clearOrderInvoiceNumber,
  getOrderByIdOrOrderId,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/admin/orders/[id]/clear-invoice-number/route";

function makeReq() {
  return new NextRequest(
    "https://example.com/api/admin/orders/ORD-1/clear-invoice-number",
    { method: "POST" }
  );
}

function paramsOf(id: string) {
  return { params: Promise.resolve({ id }) };
}

const admin = { _id: "A1", email: "admin@example.com", role: "admin" };

beforeEach(() => {
  getAdminFromRequest.mockReset().mockResolvedValue(admin);
  clearOrderInvoiceNumber.mockReset();
  getOrderByIdOrOrderId.mockReset();
});

describe("Admin gate (401)", () => {
  it("non-admin → 401 'Unauthorized'; NO order lookup", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
    expect(getOrderByIdOrOrderId).not.toHaveBeenCalled();
  });
});

describe("Order lookup", () => {
  it("getOrderByIdOrOrderId called with (id, { select: '_id orderId invoiceNumber' }) — pinned to limit fields", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(null);
    await POST(makeReq(), paramsOf("ORD-1"));
    expect(getOrderByIdOrOrderId).toHaveBeenCalledWith("ORD-1", {
      select: "_id orderId invoiceNumber",
    });
  });

  it("not found → 404 'Order not found'", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(null);
    const res = await POST(makeReq(), paramsOf("ORD-MISSING"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Order not found");
    expect(clearOrderInvoiceNumber).not.toHaveBeenCalled();
  });
});

describe("Idempotent no-op (already cleared)", () => {
  it("order with no invoiceNumber → 200 'already has no invoiceNumber'; clearOrderInvoiceNumber NOT called", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce({
      _id: "ID_1",
      orderId: "ORD-CLEARED",
      // invoiceNumber undefined
    });
    const res = await POST(makeReq(), paramsOf("ORD-CLEARED"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      message: "Order already has no invoiceNumber",
      orderId: "ORD-CLEARED",
    });
    expect(clearOrderInvoiceNumber).not.toHaveBeenCalled();
  });

  it("order with empty-string invoiceNumber treated as already cleared", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce({
      _id: "ID_1",
      orderId: "ORD-1",
      invoiceNumber: "",
    });
    const res = await POST(makeReq(), paramsOf("ORD-1"));
    const body = await res.json();
    expect(body.message).toBe("Order already has no invoiceNumber");
    expect(clearOrderInvoiceNumber).not.toHaveBeenCalled();
  });
});

describe("Happy path — invoice number present", () => {
  it("calls clearOrderInvoiceNumber with order._id (NOT the route param); response includes previousInvoiceNumber + freed-message", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce({
      _id: "DOC_INTERNAL_ID_507f",
      orderId: "ORD-USER-FACING",
      invoiceNumber: "INV-2026-00042",
    });
    clearOrderInvoiceNumber.mockResolvedValueOnce(undefined);

    const res = await POST(makeReq(), paramsOf("ORD-USER-FACING"));
    expect(res.status).toBe(200);
    expect(clearOrderInvoiceNumber).toHaveBeenCalledWith(
      "DOC_INTERNAL_ID_507f"
    );

    const body = await res.json();
    expect(body).toEqual({
      success: true,
      message:
        'Cleared invoiceNumber "INV-2026-00042" — the value is now free for another Order to claim.',
      orderId: "ORD-USER-FACING",
      previousInvoiceNumber: "INV-2026-00042",
    });
  });
});

describe("Outer catch — error-leak pinned (matches 7gr/7go family)", () => {
  it("Error instance throw → 500 with raw err.message (coordinated future-hardening signal)", async () => {
    getOrderByIdOrOrderId.mockRejectedValueOnce(
      new Error("Mongo write concern timeout: bson failure")
    );
    const res = await POST(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Mongo write concern timeout: bson failure");
  });

  it("non-Error throw → 'Action failed' fallback", async () => {
    getOrderByIdOrOrderId.mockRejectedValueOnce("string-throw");
    const res = await POST(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Action failed");
  });
});
