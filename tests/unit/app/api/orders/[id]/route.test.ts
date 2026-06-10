/**
 * Tests for `app/api/orders/[id]/route.ts` (slice 7gn, part 2).
 * Customer-facing single-order lookup. Returns the FULL order
 * shape — no field selection. The user-facing endpoint
 * `/api/user/orders/[id]` (part 3) is the field-filtered version.
 *
 * Pins:
 *  - Auth gate FIRST → 401; NO order lookup
 *  - **IDOR via findUserOrder(id, String(user._id || user.id))**
 *    — the SECOND argument is the resolved user._id (or .id),
 *    which scopes the query so a non-owner can never reach the
 *    document. Pinned because a regression that drops the user
 *    argument would let any logged-in user fetch any order.
 *  - not-found (or not-owner) → 404 'Order not found' (ambiguous
 *    — same response for "doesn't exist" and "not yours")
 *  - 200 with `{ success:true, order }` on found
 *  - Outer catch → 500 'Failed to fetch order' (no leak)
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

import { GET } from "@/app/api/orders/[id]/route";

function makeReq() {
  return new NextRequest("https://example.com/api/orders/ORD-1", {
    method: "GET",
  });
}

function paramsOf(id: string) {
  return { params: Promise.resolve({ id }) };
}

const user = { _id: "U1", email: "alice@example.com" };

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(user);
  findUserOrder.mockReset();
});

describe("Auth gate", () => {
  it("no user → 401; NO order lookup", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(401);
    expect(findUserOrder).not.toHaveBeenCalled();
  });
});

describe("IDOR — findUserOrder scoped on user._id", () => {
  it("called with (id, String(user._id)) — second arg pinned as the auth user, not request data", async () => {
    findUserOrder.mockResolvedValueOnce({ orderId: "ORD-1" });
    await GET(makeReq(), paramsOf("ORD-1"));
    expect(findUserOrder).toHaveBeenCalledWith("ORD-1", "U1");
  });

  it("falls back to user.id when _id is missing (legacy auth shape)", async () => {
    getUserFromRequest.mockResolvedValueOnce({
      // No _id, only id
      id: "U-LEGACY",
      email: "leg@x.com",
    });
    findUserOrder.mockResolvedValueOnce({ orderId: "ORD-1" });
    await GET(makeReq(), paramsOf("ORD-1"));
    expect(findUserOrder).toHaveBeenCalledWith("ORD-1", "U-LEGACY");
  });

  it("non-owner / not-found → 404 'Order not found' (ambiguous)", async () => {
    findUserOrder.mockResolvedValueOnce(null);
    const res = await GET(makeReq(), paramsOf("ORD-999"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Order not found");
  });
});

describe("Success", () => {
  it("returns { success:true, order } with full document", async () => {
    findUserOrder.mockResolvedValueOnce({
      orderId: "ORD-1",
      amount: 999,
      status: "completed",
    });
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.order).toEqual({
      orderId: "ORD-1",
      amount: 999,
      status: "completed",
    });
  });
});

describe("Error handling", () => {
  it("findUserOrder throw → 500 'Failed to fetch order' (no leak)", async () => {
    findUserOrder.mockRejectedValueOnce(new Error("Mongo timeout"));
    const res = await GET(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch order");
    expect(body.error).not.toContain("Mongo timeout");
  });
});
