/**
 * Tests for `app/api/user/orders/[id]/route.ts` (slice 7gn, part 3).
 * The user-facing single-order endpoint. Same IDOR scoping as
 * `/api/orders/[id]` (part 2), with one important difference:
 * **this endpoint applies a field-selection allow-list** so admin-
 * only fields (internal notes, raw provider responses, refund
 * decision audit) never reach the customer.
 *
 * Pins:
 *  - Auth gate FIRST → 401 UNAUTHORIZED via secureErrorResponse
 *  - Missing id → 400 MISSING_ID (shouldn't happen via routing
 *    but defensive guard pinned)
 *  - **findUserOrder called with select option containing the
 *    customer-safe field list** — pinned VERBATIM so a refactor
 *    that adds an admin-only field to the source string is flagged
 *    by this test
 *  - IDOR: scoped on String(user._id); not-found → 404 NOT_FOUND
 *  - 200 with `{ order }` on success
 *  - Outer catch → 500 SERVER_ERROR
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const findUserOrder = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({ findUserOrder }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/user/orders/[id]/route";

function makeReq() {
  return new NextRequest("https://example.com/api/user/orders/ORD-1", {
    method: "GET",
  });
}

function paramsOf(id: string) {
  return { params: Promise.resolve({ id }) };
}

const user = { _id: "U1", email: "alice@example.com" };

// Customer-safe field allow-list — must stay in sync with the route source
const EXPECTED_FIELDS =
  "orderId purchaseOrderNumber amount currency status orderType " +
  "domains successfulDomains invoiceNumber zohoInvoiceId " +
  "createdAt updatedAt paymentVerification";

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(user);
  findUserOrder.mockReset();
});

describe("Auth gate", () => {
  it("no user → 401 UNAUTHORIZED; NO order lookup", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(401);
    expect(findUserOrder).not.toHaveBeenCalled();
  });
});

describe("Missing id guard", () => {
  it("empty id → 400 MISSING_ID", async () => {
    const res = await GET(makeReq(), paramsOf(""));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("MISSING_ID");
  });
});

describe("Field-selection allow-list (PII / admin-field leak guard)", () => {
  it("findUserOrder called with the customer-safe field list — pinned VERBATIM", async () => {
    findUserOrder.mockResolvedValueOnce({ orderId: "ORD-1" });
    await GET(makeReq(), paramsOf("ORD-1"));
    expect(findUserOrder).toHaveBeenCalledWith("ORD-1", "U1", {
      select: EXPECTED_FIELDS,
    });
  });

  it("the select string does NOT include any known admin-only fields", async () => {
    // If a refactor adds something dangerous like adminNotes / refundAuditLog
    // / internalReason to the select string, this test will fail.
    const dangerousFields = [
      "adminNotes",
      "internalNotes",
      "refundAuditLog",
      "internalReason",
      "rawRazorpayResponse",
      "rawZohoResponse",
      "razorpayKeyId",
    ];
    findUserOrder.mockResolvedValueOnce({ orderId: "ORD-1" });
    await GET(makeReq(), paramsOf("ORD-1"));

    const selectArg = findUserOrder.mock.calls[0][2].select as string;
    for (const f of dangerousFields) {
      expect(selectArg).not.toContain(f);
    }
  });
});

describe("IDOR — not-found", () => {
  it("non-owner / not-found → 404 NOT_FOUND", async () => {
    findUserOrder.mockResolvedValueOnce(null);
    const res = await GET(makeReq(), paramsOf("ORD-OTHER-USER"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });
});

describe("Success", () => {
  it("returns { order } with the (already-filtered) order", async () => {
    findUserOrder.mockResolvedValueOnce({
      orderId: "ORD-1",
      amount: 999,
      status: "completed",
    });
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.order).toEqual({
      orderId: "ORD-1",
      amount: 999,
      status: "completed",
    });
  });
});

describe("Outer catch", () => {
  it("findUserOrder throw → 500 SERVER_ERROR", async () => {
    findUserOrder.mockRejectedValueOnce(new Error("Mongo timeout"));
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("SERVER_ERROR");
  });
});
