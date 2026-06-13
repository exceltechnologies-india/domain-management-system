/**
 * Tests for `app/api/admin/orders/invoice-conflicts/route.ts`
 * (slice 7hx, part 2).
 *
 * Admin diagnostic dashboard: surfaces invoiceNumber collisions +
 * stuck-Zoho-invoice orders. The two classes of bad state that cause
 * the user-visible "Generating invoice…" pill or E11000 duplicate-key
 * errors during the Zoho retry path.
 *
 * Threat model:
 *  - **Non-admin probe of payment internals**: this endpoint exposes
 *    user email + payment IDs + Zoho/Razorpay metadata. Must be
 *    admin-only. Pinned: 401 before any DB read.
 *  - **Unbounded stuck-order list**: a runaway Zoho outage could
 *    leave thousands of stuck orders, and an unbounded fetch would
 *    OOM the page. Pinned: 100-cap.
 *
 * Other pins:
 *  - Admin gate → 401 (NOT 403 — chose 401 historically)
 *  - findInvoiceNumberConflicts groups orders by invoiceNumber
 *  - listOrdersByIds called with the exact projection string
 *  - User cache: findUsersByIds dedup; second call skips already-cached
 *  - slim shape: { _id, orderId, userId, userEmail, userName,
 *    status, amount, invoiceNumber, zohoInvoiceId, razorpayPaymentId,
 *    createdAt:string, isDeleted }
 *  - userName template-literal quirk: missing firstName/lastName →
 *    empty string (uses || '' fallback — better than the test-plan
 *    'undefined undefined' quirk)
 *  - createdAt converted to ISO string; missing → ''
 *  - listStuckZohoInvoiceOrdersAdmin called with limit:100
 *  - Summary block: conflictGroups, conflictedOrders, stuckOrders
 *  - Outer catch → 500 with err.message (no static masking — pin
 *    that this is currently a leak; future hardening would mask)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const findInvoiceNumberConflicts = vi.hoisted(() => vi.fn());
const listOrdersByIds = vi.hoisted(() => vi.fn());
const listStuckZohoInvoiceOrdersAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  findInvoiceNumberConflicts,
  listOrdersByIds,
  listStuckZohoInvoiceOrdersAdmin,
}));

const findUsersByIds = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ findUsersByIds }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/admin/orders/invoice-conflicts/route";

function makeReq() {
  return new NextRequest(
    "https://example.com/api/admin/orders/invoice-conflicts",
    { method: "GET" }
  );
}

beforeEach(() => {
  getAdminFromRequest.mockReset().mockResolvedValue({ _id: "ADMIN1" });
  findInvoiceNumberConflicts.mockReset().mockResolvedValue([]);
  listOrdersByIds.mockReset().mockResolvedValue([]);
  listStuckZohoInvoiceOrdersAdmin.mockReset().mockResolvedValue([]);
  findUsersByIds.mockReset().mockResolvedValue([]);
});

describe("Admin gate", () => {
  it("non-admin → 401; NO DB read", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    expect(findInvoiceNumberConflicts).not.toHaveBeenCalled();
    expect(listStuckZohoInvoiceOrdersAdmin).not.toHaveBeenCalled();
  });
});

describe("Empty state", () => {
  it("no conflicts + no stuck → 200 with all-zero summary", async () => {
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body).toEqual(
      expect.objectContaining({
        success: true,
        conflicts: [],
        stuckOrders: [],
        summary: {
          conflictGroups: 0,
          conflictedOrders: 0,
          stuckOrders: 0,
        },
      })
    );
  });
});

describe("Conflict group resolution", () => {
  it("groups → resolved orders + user-join + slim shape", async () => {
    findInvoiceNumberConflicts.mockResolvedValueOnce([
      { _id: "INV-001", count: 2, orderIds: ["O1", "O2"] },
    ]);
    listOrdersByIds.mockResolvedValueOnce([
      {
        _id: "O1",
        orderId: "ORD-A",
        userId: "U1",
        status: "completed",
        amount: 999,
        invoiceNumber: "INV-001",
        zohoInvoiceId: "ZH-1",
        razorpayPaymentId: "PAY-1",
        createdAt: new Date("2026-06-01"),
      },
      {
        _id: "O2",
        orderId: "ORD-B",
        userId: "U2",
        status: "completed",
        amount: 1099,
        invoiceNumber: "INV-001",
        createdAt: new Date("2026-06-02"),
      },
    ]);
    findUsersByIds.mockResolvedValueOnce([
      { _id: "U1", email: "alice@example.com", firstName: "Alice", lastName: "Smith" },
      { _id: "U2", email: "bob@example.com", firstName: "Bob" },
    ]);

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.conflicts).toHaveLength(1);
    expect(body.conflicts[0]).toEqual(
      expect.objectContaining({
        invoiceNumber: "INV-001",
        count: 2,
      })
    );
    expect(body.conflicts[0].orders).toHaveLength(2);
    expect(body.conflicts[0].orders[0]).toEqual(
      expect.objectContaining({
        orderId: "ORD-A",
        userEmail: "alice@example.com",
        userName: "Alice Smith",
        invoiceNumber: "INV-001",
        zohoInvoiceId: "ZH-1",
        razorpayPaymentId: "PAY-1",
      })
    );
    // Bob has firstName only — userName trimmed
    expect(body.conflicts[0].orders[1].userName).toBe("Bob");
  });

  it("createdAt converted to ISO string; missing → ''", async () => {
    findInvoiceNumberConflicts.mockResolvedValueOnce([
      { _id: "INV-X", count: 1, orderIds: ["O1"] },
    ]);
    listOrdersByIds.mockResolvedValueOnce([
      {
        _id: "O1",
        orderId: "ORD-A",
        userId: "U1",
        status: "completed",
        amount: 100,
        // No createdAt at all
      },
    ]);
    findUsersByIds.mockResolvedValueOnce([{ _id: "U1" }]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.conflicts[0].orders[0].createdAt).toBe("");
  });

  it("missing user in cache → userEmail undefined, userName undefined", async () => {
    findInvoiceNumberConflicts.mockResolvedValueOnce([
      { _id: "INV-X", count: 1, orderIds: ["O1"] },
    ]);
    listOrdersByIds.mockResolvedValueOnce([
      {
        _id: "O1",
        orderId: "ORD-A",
        userId: "U_MISSING",
        status: "completed",
        amount: 100,
        createdAt: new Date("2026-06-01"),
      },
    ]);
    findUsersByIds.mockResolvedValueOnce([]); // no user found
    const res = await GET(makeReq());
    const body = await res.json();
    const order = body.conflicts[0].orders[0];
    expect(order.userEmail).toBeUndefined();
    expect(order.userName).toBeUndefined();
  });

  it("orphan orderId (in conflict aggregation but missing from listOrdersByIds) filtered out", async () => {
    findInvoiceNumberConflicts.mockResolvedValueOnce([
      { _id: "INV-X", count: 3, orderIds: ["O1", "O_MISSING", "O3"] },
    ]);
    listOrdersByIds.mockResolvedValueOnce([
      {
        _id: "O1",
        orderId: "ORD-A",
        userId: "U1",
        status: "completed",
        amount: 100,
      },
      {
        _id: "O3",
        orderId: "ORD-C",
        userId: "U1",
        status: "completed",
        amount: 200,
      },
    ]);
    findUsersByIds.mockResolvedValueOnce([{ _id: "U1" }]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.conflicts[0].orders).toHaveLength(2);
  });
});

describe("listOrdersByIds projection", () => {
  it("called with the exact projection string (10 fields pinned)", async () => {
    findInvoiceNumberConflicts.mockResolvedValueOnce([
      { _id: "INV", count: 1, orderIds: ["O1"] },
    ]);
    listOrdersByIds.mockResolvedValueOnce([]);
    findUsersByIds.mockResolvedValueOnce([]);
    await GET(makeReq());
    const projection = listOrdersByIds.mock.calls[0][1];
    expect(projection).toBe(
      "_id orderId userId userEmail userName status amount invoiceNumber zohoInvoiceId razorpayPaymentId createdAt isDeleted"
    );
  });
});

describe("Stuck-orders branch — 100-cap + projection", () => {
  it("listStuckZohoInvoiceOrdersAdmin called with limit:100", async () => {
    await GET(makeReq());
    expect(listStuckZohoInvoiceOrdersAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 })
    );
  });

  it("projection passed through; same 10-field shape", async () => {
    await GET(makeReq());
    const opts = listStuckZohoInvoiceOrdersAdmin.mock.calls[0][0];
    expect(opts.select).toContain("orderId");
    expect(opts.select).toContain("zohoInvoiceId");
  });
});

describe("User-cache reuse across the two diagnostic legs", () => {
  it("user found in conflict leg is NOT re-fetched for the stuck leg", async () => {
    findInvoiceNumberConflicts.mockResolvedValueOnce([
      { _id: "INV", count: 1, orderIds: ["O1"] },
    ]);
    listOrdersByIds.mockResolvedValueOnce([
      {
        _id: "O1",
        orderId: "ORD-A",
        userId: "U1",
        status: "completed",
        amount: 100,
      },
    ]);
    listStuckZohoInvoiceOrdersAdmin.mockResolvedValueOnce([
      {
        _id: "O2",
        orderId: "ORD-B",
        userId: "U1", // same user — should be served from cache
        status: "completed",
        amount: 200,
      },
    ]);
    findUsersByIds
      .mockResolvedValueOnce([
        { _id: "U1", email: "alice@example.com", firstName: "Alice" },
      ])
      // second call should receive empty array (U1 was already cached)
      .mockResolvedValueOnce([]);

    const res = await GET(makeReq());
    expect(res.status).toBe(200);

    // The second findUsersByIds call must be passed [] (no new IDs to fetch)
    expect(findUsersByIds.mock.calls[1][0]).toEqual([]);

    const body = await res.json();
    expect(body.stuckOrders[0].userEmail).toBe("alice@example.com");
  });

  it("new user in stuck leg → second findUsersByIds call carries the new ID only", async () => {
    findInvoiceNumberConflicts.mockResolvedValueOnce([
      { _id: "INV", count: 1, orderIds: ["O1"] },
    ]);
    listOrdersByIds.mockResolvedValueOnce([
      {
        _id: "O1",
        orderId: "ORD-A",
        userId: "U1",
        status: "completed",
        amount: 100,
      },
    ]);
    listStuckZohoInvoiceOrdersAdmin.mockResolvedValueOnce([
      {
        _id: "O2",
        orderId: "ORD-B",
        userId: "U2", // NEW user — must be fetched
        status: "completed",
        amount: 200,
      },
    ]);
    findUsersByIds
      .mockResolvedValueOnce([{ _id: "U1" }])
      .mockResolvedValueOnce([{ _id: "U2", email: "bob@example.com" }]);

    const res = await GET(makeReq());
    expect(findUsersByIds.mock.calls[1][0]).toEqual(["U2"]);

    const body = await res.json();
    expect(body.stuckOrders[0].userEmail).toBe("bob@example.com");
  });
});

describe("Summary block math", () => {
  it("counts groups + total orders across groups + stuck total", async () => {
    findInvoiceNumberConflicts.mockResolvedValueOnce([
      { _id: "INV-1", count: 2, orderIds: ["O1", "O2"] },
      { _id: "INV-2", count: 3, orderIds: ["O3", "O4", "O5"] },
    ]);
    listOrdersByIds.mockResolvedValueOnce([
      { _id: "O1", orderId: "A", userId: "U1", status: "x", amount: 1 },
      { _id: "O2", orderId: "B", userId: "U1", status: "x", amount: 1 },
      { _id: "O3", orderId: "C", userId: "U1", status: "x", amount: 1 },
      { _id: "O4", orderId: "D", userId: "U1", status: "x", amount: 1 },
      { _id: "O5", orderId: "E", userId: "U1", status: "x", amount: 1 },
    ]);
    findUsersByIds.mockResolvedValue([{ _id: "U1" }]);
    listStuckZohoInvoiceOrdersAdmin.mockResolvedValueOnce([
      { _id: "S1", orderId: "S1", userId: "U1", status: "x", amount: 1 },
      { _id: "S2", orderId: "S2", userId: "U1", status: "x", amount: 1 },
    ]);

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.summary).toEqual({
      conflictGroups: 2,
      conflictedOrders: 5,
      stuckOrders: 2,
    });
  });
});

describe("Outer catch", () => {
  it("findInvoiceNumberConflicts throw → 500 with err.message (FAMILY-QUIRK: raw leak)", async () => {
    findInvoiceNumberConflicts.mockRejectedValueOnce(
      new Error("Mongo replica lost — internal_state_LEAK_ME")
    );
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    // Known leak — pin at current behaviour. Future hardening (along
    // with the other family routes) would mask to a static string.
    expect(body.error).toContain("internal_state_LEAK_ME");
  });

  it("non-Error throw → falls back to 'Diagnostics failed'", async () => {
    findInvoiceNumberConflicts.mockRejectedValueOnce("oddball string");
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.error).toBe("Diagnostics failed");
  });
});
