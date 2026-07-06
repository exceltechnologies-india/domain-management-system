/**
 * Tests for `app/api/admin/orders/route.ts` (GET LIST) +
 * `app/api/admin/orders/[id]/route.ts` (DELETE + PATCH). Slice 7ga.
 * Thin admin handlers; the heavy lifting is in
 * `@/lib/services/orders` (already tested in slice 7ek + 7ew + 7ex).
 *
 * GET (list) pins:
 *  - Admin auth gate (getAdminFromRequest null → 401)
 *  - Query params: archived (=== 'true' literal), page (default 1),
 *    perPage (default 100; query key 'per_page')
 *  - listOrdersForAdmin call shape: {archived, page, perPage}
 *  - Response: success + orders + page_context{has_more_page, page,
 *    per_page, total}
 *  - 500 on service throw
 *
 * DELETE [id] pins:
 *  - Admin gate → 401
 *  - getOrderById null → 404 'Order not found'
 *  - `?permanent=true` → permanentlyDeleteOrder + 'permanently deleted'
 *  - default (no flag or any other value) → softDeleteOrder +
 *    'archived successfully'
 *  - Response: success + message + deletedOrderId (echoes order.orderId)
 *  - 500 on service throw
 *
 * PATCH [id] (unarchive) pins:
 *  - Admin gate → 401
 *  - unarchiveOrder null → 404 'Order not found'
 *  - success → message 'un-archived successfully' + orderId echoed
 *  - 500 on service throw
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const listOrdersForAdmin = vi.hoisted(() => vi.fn());
const getOrderById = vi.hoisted(() => vi.fn());
const softDeleteOrder = vi.hoisted(() => vi.fn());
const permanentlyDeleteOrder = vi.hoisted(() => vi.fn());
const unarchiveOrder = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  listOrdersForAdmin,
  getOrderById,
  softDeleteOrder,
  permanentlyDeleteOrder,
  unarchiveOrder,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/admin/orders/route";
import { DELETE, PATCH } from "@/app/api/admin/orders/[id]/route";

function makeGetReq(qs = "") {
  const url = qs
    ? `https://example.com/api/admin/orders?${qs}`
    : "https://example.com/api/admin/orders";
  return new NextRequest(url, { method: "GET" });
}

function makeIdReq(method: "DELETE" | "PATCH", qs = "") {
  const url = qs
    ? `https://example.com/api/admin/orders/ORD-1?${qs}`
    : "https://example.com/api/admin/orders/ORD-1";
  return new NextRequest(url, { method });
}

function paramsOf(id: string) {
  return { params: Promise.resolve({ id }) };
}

const admin = { _id: "A1", email: "admin@x.com", role: "admin" };

beforeEach(() => {
  getAdminFromRequest.mockReset().mockResolvedValue(admin);
  listOrdersForAdmin.mockReset();
  getOrderById.mockReset();
  softDeleteOrder.mockReset();
  permanentlyDeleteOrder.mockReset();
  unarchiveOrder.mockReset();
});

// ─── GET LIST ──────────────────────────────────────────────────────
describe("GET — admin auth gate", () => {
  it("no admin → 401; NO service call", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeGetReq());
    expect(res.status).toBe(401);
    expect(listOrdersForAdmin).not.toHaveBeenCalled();
  });
});

describe("GET — query param parsing", () => {
  beforeEach(() => {
    listOrdersForAdmin.mockResolvedValue({
      orders: [],
      total: 0,
      hasMore: false,
    });
  });

  it("defaults: archived=false, page=1, perPage=100", async () => {
    await GET(makeGetReq());
    expect(listOrdersForAdmin).toHaveBeenCalledWith({
      archived: false,
      trialOnly: false,
      page: 1,
      perPage: 100,
    });
  });

  it("trial=true triggers trial-only query", async () => {
    await GET(makeGetReq("trial=true"));
    expect(listOrdersForAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ trialOnly: true })
    );
  });

  it("archived=true triggers archived query (strict 'true' literal)", async () => {
    await GET(makeGetReq("archived=true"));
    expect(listOrdersForAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ archived: true })
    );
  });

  it("archived=anything-other-than-true → false (anti-foot-gun)", async () => {
    await GET(makeGetReq("archived=1"));
    expect(listOrdersForAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ archived: false })
    );
  });

  it("page + per_page parsed as integers", async () => {
    await GET(makeGetReq("page=3&per_page=25"));
    expect(listOrdersForAdmin).toHaveBeenCalledWith({
      archived: false,
      trialOnly: false,
      page: 3,
      perPage: 25,
    });
  });
});

describe("GET — response shape", () => {
  it("success + orders + page_context{has_more_page, page, per_page, total}", async () => {
    listOrdersForAdmin.mockResolvedValueOnce({
      orders: [{ orderId: "ORD-1" }, { orderId: "ORD-2" }],
      total: 47,
      hasMore: true,
    });
    const res = await GET(makeGetReq("page=2&per_page=20"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      orders: [{ orderId: "ORD-1" }, { orderId: "ORD-2" }],
      page_context: {
        has_more_page: true,
        page: 2,
        per_page: 20,
        total: 47,
      },
    });
  });
});

describe("GET — error handling", () => {
  it("service throw → 500 'Failed to fetch orders'", async () => {
    listOrdersForAdmin.mockRejectedValueOnce(new Error("DB down"));
    const res = await GET(makeGetReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch orders");
  });
});

// ─── DELETE [id] ───────────────────────────────────────────────────
describe("DELETE — admin auth gate", () => {
  it("no admin → 401; NO order lookup", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await DELETE(makeIdReq("DELETE"), paramsOf("ORD-1"));
    expect(res.status).toBe(401);
    expect(getOrderById).not.toHaveBeenCalled();
  });
});

describe("DELETE — order not found", () => {
  it("getOrderById null → 404 'Order not found'", async () => {
    getOrderById.mockResolvedValueOnce(null);
    const res = await DELETE(makeIdReq("DELETE"), paramsOf("ORD-1"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Order not found");
    expect(softDeleteOrder).not.toHaveBeenCalled();
    expect(permanentlyDeleteOrder).not.toHaveBeenCalled();
  });
});

describe("DELETE — soft delete (default — archive)", () => {
  it("no permanent flag → softDeleteOrder + 'archived successfully'", async () => {
    getOrderById.mockResolvedValueOnce({ orderId: "ORD-1" });
    softDeleteOrder.mockResolvedValueOnce({ orderId: "ORD-1" });

    const res = await DELETE(makeIdReq("DELETE"), paramsOf("ORD-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      message: "Order archived successfully",
      deletedOrderId: "ORD-1",
    });
    expect(softDeleteOrder).toHaveBeenCalledWith("ORD-1");
    expect(permanentlyDeleteOrder).not.toHaveBeenCalled();
  });

  it("permanent=anything-other-than-true → soft delete (anti-foot-gun)", async () => {
    getOrderById.mockResolvedValueOnce({ orderId: "ORD-1" });
    softDeleteOrder.mockResolvedValueOnce({ orderId: "ORD-1" });

    await DELETE(makeIdReq("DELETE", "permanent=1"), paramsOf("ORD-1"));
    expect(softDeleteOrder).toHaveBeenCalled();
    expect(permanentlyDeleteOrder).not.toHaveBeenCalled();
  });
});

describe("DELETE — permanent delete", () => {
  it("?permanent=true → permanentlyDeleteOrder + 'permanently deleted'", async () => {
    getOrderById.mockResolvedValueOnce({ orderId: "ORD-1" });
    permanentlyDeleteOrder.mockResolvedValueOnce(undefined);

    const res = await DELETE(
      makeIdReq("DELETE", "permanent=true"),
      paramsOf("ORD-1")
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      message: "Order permanently deleted",
      deletedOrderId: "ORD-1",
    });
    expect(permanentlyDeleteOrder).toHaveBeenCalledWith("ORD-1");
    expect(softDeleteOrder).not.toHaveBeenCalled();
  });
});

describe("DELETE — error handling", () => {
  it("service throw → 500 'Failed to delete order'", async () => {
    getOrderById.mockRejectedValueOnce(new Error("DB down"));
    const res = await DELETE(makeIdReq("DELETE"), paramsOf("ORD-1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to delete order");
  });
});

// ─── PATCH [id] (unarchive) ────────────────────────────────────────
describe("PATCH — admin auth gate", () => {
  it("no admin → 401; NO unarchive call", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await PATCH(makeIdReq("PATCH"), paramsOf("ORD-1"));
    expect(res.status).toBe(401);
    expect(unarchiveOrder).not.toHaveBeenCalled();
  });
});

describe("PATCH — unarchive flow", () => {
  it("unarchiveOrder null → 404 'Order not found'", async () => {
    unarchiveOrder.mockResolvedValueOnce(null);
    const res = await PATCH(makeIdReq("PATCH"), paramsOf("ORD-1"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Order not found");
  });

  it("success → 'un-archived successfully' + orderId echoed", async () => {
    unarchiveOrder.mockResolvedValueOnce({ orderId: "ORD-RESTORED" });

    const res = await PATCH(makeIdReq("PATCH"), paramsOf("ORD-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      message: "Order un-archived successfully",
      orderId: "ORD-RESTORED",
    });
    expect(unarchiveOrder).toHaveBeenCalledWith("ORD-1");
  });
});

describe("PATCH — error handling", () => {
  it("service throw → 500 'Failed to un-archive order'", async () => {
    unarchiveOrder.mockRejectedValueOnce(new Error("DB down"));
    const res = await PATCH(makeIdReq("PATCH"), paramsOf("ORD-1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to un-archive order");
  });
});
