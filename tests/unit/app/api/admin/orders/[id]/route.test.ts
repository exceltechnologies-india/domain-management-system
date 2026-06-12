/**
 * Tests for `app/api/admin/orders/[id]/route.ts` (slice 7hs, part 1).
 *
 * Admin order-management actions: DELETE (soft-vs-permanent) + PATCH
 * (un-archive). The single most-destructive admin endpoint outside
 * the system-management surface.
 *
 * Threat model:
 *  - **Accidental hard-delete via UX miss**: a refactor that defaults
 *    `permanent` to true (or falsy-coerces it to true) would silently
 *    wipe orders without admin intent. Pinned: ONLY the literal
 *    string "true" in the query param triggers permanent delete —
 *    anything else (omitted / "1" / "yes" / "TRUE") is soft.
 *  - **Order-not-found masking**: DELETE must NOT 200 on a missing id
 *    (admin would think they deleted something they didn't). Pinned
 *    with explicit 404.
 *
 * Other pins:
 *  - Admin gate first → 401; no order lookup
 *  - DELETE soft path: softDeleteOrder called; permanentlyDeleteOrder
 *    NOT called; response 200 with "archived" message + deletedOrderId
 *  - DELETE permanent path: permanentlyDeleteOrder called;
 *    softDeleteOrder NOT called; response message contains "permanently"
 *  - PATCH unarchive: unarchiveOrder returns null → 404; else 200 with
 *    orderId
 *  - Outer catch → 500 generic per-method
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const getOrderById = vi.hoisted(() => vi.fn());
const softDeleteOrder = vi.hoisted(() => vi.fn());
const permanentlyDeleteOrder = vi.hoisted(() => vi.fn());
const unarchiveOrder = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
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

import { DELETE, PATCH } from "@/app/api/admin/orders/[id]/route";

function makeReq(method: "DELETE" | "PATCH", qs = "") {
  const url = qs
    ? `https://example.com/api/admin/orders/ORD-1?${qs}`
    : "https://example.com/api/admin/orders/ORD-1";
  return new NextRequest(url, { method });
}

function makeParams(id = "ORD-1") {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  getAdminFromRequest.mockReset().mockResolvedValue({
    _id: "ADMIN1",
    email: "admin@example.com",
  });
  getOrderById.mockReset();
  softDeleteOrder.mockReset().mockResolvedValue(undefined);
  permanentlyDeleteOrder.mockReset().mockResolvedValue(undefined);
  unarchiveOrder.mockReset();
});

// ─────────────────────────── DELETE ─────────────────────────────

describe("DELETE — admin gate", () => {
  it("non-admin → 401; no order lookup; no delete", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await DELETE(makeReq("DELETE"), makeParams());
    expect(res.status).toBe(401);
    expect(getOrderById).not.toHaveBeenCalled();
    expect(softDeleteOrder).not.toHaveBeenCalled();
    expect(permanentlyDeleteOrder).not.toHaveBeenCalled();
  });
});

describe("DELETE — order lookup", () => {
  it("getOrderById null → 404; NO delete attempted", async () => {
    getOrderById.mockResolvedValueOnce(null);
    const res = await DELETE(makeReq("DELETE"), makeParams());
    expect(res.status).toBe(404);
    expect(softDeleteOrder).not.toHaveBeenCalled();
    expect(permanentlyDeleteOrder).not.toHaveBeenCalled();
  });
});

describe("DELETE — soft (default) vs permanent dispatch", () => {
  function setupOrder() {
    getOrderById.mockResolvedValueOnce({
      _id: "ORD-1",
      orderId: "ORD-12345",
    });
  }

  it("no query param → SOFT delete (default)", async () => {
    setupOrder();
    const res = await DELETE(makeReq("DELETE"), makeParams());
    expect(res.status).toBe(200);
    expect(softDeleteOrder).toHaveBeenCalledTimes(1);
    expect(permanentlyDeleteOrder).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.message.toLowerCase()).toContain("archived");
    expect(body.deletedOrderId).toBe("ORD-12345");
  });

  it("?permanent=true → PERMANENT delete; soft delete NOT called", async () => {
    setupOrder();
    const res = await DELETE(
      makeReq("DELETE", "permanent=true"),
      makeParams()
    );
    expect(res.status).toBe(200);
    expect(permanentlyDeleteOrder).toHaveBeenCalledTimes(1);
    expect(softDeleteOrder).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.message.toLowerCase()).toContain("permanently");
  });

  it("CRITICAL: strict-true comparison — `?permanent=TRUE` does NOT trigger permanent (case-sensitive)", async () => {
    setupOrder();
    await DELETE(makeReq("DELETE", "permanent=TRUE"), makeParams());
    expect(softDeleteOrder).toHaveBeenCalledTimes(1);
    expect(permanentlyDeleteOrder).not.toHaveBeenCalled();
  });

  it("strict-true: `?permanent=1` → soft (not permanent)", async () => {
    setupOrder();
    await DELETE(makeReq("DELETE", "permanent=1"), makeParams());
    expect(softDeleteOrder).toHaveBeenCalledTimes(1);
    expect(permanentlyDeleteOrder).not.toHaveBeenCalled();
  });

  it("strict-true: `?permanent=yes` → soft (not permanent)", async () => {
    setupOrder();
    await DELETE(makeReq("DELETE", "permanent=yes"), makeParams());
    expect(softDeleteOrder).toHaveBeenCalledTimes(1);
    expect(permanentlyDeleteOrder).not.toHaveBeenCalled();
  });

  it("strict-true: `?permanent` (no value) → soft (not permanent)", async () => {
    setupOrder();
    await DELETE(makeReq("DELETE", "permanent"), makeParams());
    expect(softDeleteOrder).toHaveBeenCalledTimes(1);
    expect(permanentlyDeleteOrder).not.toHaveBeenCalled();
  });
});

describe("DELETE — outer catch", () => {
  it("softDeleteOrder throw → 500 generic", async () => {
    getOrderById.mockResolvedValueOnce({ orderId: "ORD-1" });
    softDeleteOrder.mockRejectedValueOnce(new Error("Mongo blip"));
    const res = await DELETE(makeReq("DELETE"), makeParams());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to delete order");
  });
});

// ─────────────────────────── PATCH ─────────────────────────────

describe("PATCH (un-archive) — admin gate", () => {
  it("non-admin → 401; unarchiveOrder NOT called", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await PATCH(makeReq("PATCH"), makeParams());
    expect(res.status).toBe(401);
    expect(unarchiveOrder).not.toHaveBeenCalled();
  });
});

describe("PATCH (un-archive) — happy path + 404", () => {
  it("unarchiveOrder returns the row → 200 with orderId", async () => {
    unarchiveOrder.mockResolvedValueOnce({
      _id: "ORD-1",
      orderId: "ORD-67890",
    });
    const res = await PATCH(makeReq("PATCH"), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.orderId).toBe("ORD-67890");
  });

  it("unarchiveOrder returns null → 404 (not-found)", async () => {
    unarchiveOrder.mockResolvedValueOnce(null);
    const res = await PATCH(makeReq("PATCH"), makeParams());
    expect(res.status).toBe(404);
  });
});

describe("PATCH — outer catch", () => {
  it("unarchiveOrder throw → 500 generic", async () => {
    unarchiveOrder.mockRejectedValueOnce(new Error("DB down"));
    const res = await PATCH(makeReq("PATCH"), makeParams());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to un-archive order");
  });
});
