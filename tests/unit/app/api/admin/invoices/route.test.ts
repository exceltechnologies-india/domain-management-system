/**
 * Tests for `app/api/admin/invoices/route.ts`.
 *
 * Since Zoho Books was removed (24 Sep 2026) this route has ONE source: our
 * own database, via `listInvoiceOrdersAdmin`. There is no `source` param any
 * more — every issued invoice (primary-engine, and historical Zoho ones that
 * still carry `invoiceProvider: 'zoho'`) lives in the same collection.
 *
 * Pins:
 *  - connectDB BEFORE auth
 *  - Admin gate via getAdminFromRequest → 401 'Unauthorized', no DB read
 *  - Query parsing: page default 1, per_page default 20; parseInt with no
 *    clamp in the route (the service clamps — so NaN reaches it and the
 *    service decides)
 *  - Row shape: invoice_id = order.orderId, order_id = order.orderId,
 *    provider = order.invoiceProvider (so a historical 'zoho' row is labelled
 *    as such, not silently relabelled 'primary')
 *  - page_context carries the REAL total from the service
 *  - Outer catch → 500 'Failed to fetch invoices' (no leak)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const connectDB = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

const listInvoiceOrdersAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({ listInvoiceOrdersAdmin }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/admin/invoices/route";

function makeReq(qs = "") {
  const url = qs
    ? `https://example.com/api/admin/invoices?${qs}`
    : "https://example.com/api/admin/invoices";
  return new NextRequest(url, { method: "GET" });
}

const order = (o: Record<string, unknown> = {}) => ({
  orderId: "ORD-1",
  invoiceNumber: "TI/2026-27/00001",
  invoiceProvider: "primary",
  userName: "Alice Anderson",
  userEmail: "alice@example.com",
  amount: 1180,
  currency: "INR",
  status: "completed",
  createdAt: new Date("2026-09-01T10:00:00.000Z"),
  ...o,
});

beforeEach(() => {
  getAdminFromRequest.mockReset();
  connectDB.mockClear().mockResolvedValue(undefined);
  listInvoiceOrdersAdmin.mockReset();
});

describe("connectDB ordering", () => {
  it("connectDB called BEFORE the auth gate (current source order — pinned)", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    await GET(makeReq());
    expect(connectDB).toHaveBeenCalled();
  });
});

describe("Admin gate", () => {
  it("non-admin → 401 'Unauthorized'; NO DB read", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
    expect(listInvoiceOrdersAdmin).not.toHaveBeenCalled();
  });
});

describe("Query parsing", () => {
  it("no query params → listInvoiceOrdersAdmin(1, 20)", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    listInvoiceOrdersAdmin.mockResolvedValueOnce({ orders: [], hasMore: false, total: 0 });
    await GET(makeReq());
    expect(listInvoiceOrdersAdmin).toHaveBeenCalledWith(1, 20);
  });

  it("?page=3&per_page=50 → listInvoiceOrdersAdmin(3, 50)", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    listInvoiceOrdersAdmin.mockResolvedValueOnce({ orders: [], hasMore: false, total: 0 });
    await GET(makeReq("page=3&per_page=50"));
    expect(listInvoiceOrdersAdmin).toHaveBeenCalledWith(3, 50);
  });

  it("?page=abc&per_page=xyz → NaN reaches the service (the service clamps; the route does not)", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    listInvoiceOrdersAdmin.mockResolvedValueOnce({ orders: [], hasMore: false, total: 0 });
    await GET(makeReq("page=abc&per_page=xyz"));
    expect(listInvoiceOrdersAdmin).toHaveBeenCalledWith(NaN, NaN);
  });

  it("a leftover ?source=zoho is ignored — there is only one source now", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    listInvoiceOrdersAdmin.mockResolvedValueOnce({ orders: [], hasMore: false, total: 0 });
    const res = await GET(makeReq("source=zoho"));
    expect(res.status).toBe(200);
    expect(listInvoiceOrdersAdmin).toHaveBeenCalledWith(1, 20);
  });
});

describe("Row mapping", () => {
  it("maps an Order to the invoice row shape; invoice_id and order_id are both the orderId", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    listInvoiceOrdersAdmin.mockResolvedValueOnce({ orders: [order()], hasMore: false, total: 1 });
    const body = await (await GET(makeReq())).json();
    expect(body.success).toBe(true);
    expect(body.invoices[0]).toEqual({
      invoice_id: "ORD-1",
      invoice_number: "TI/2026-27/00001",
      customer_name: "Alice Anderson",
      email: "alice@example.com",
      date: "2026-09-01T10:00:00.000Z",
      due_date: "2026-09-01T10:00:00.000Z",
      created_time: "2026-09-01T10:00:00.000Z",
      total: 1180,
      balance: 0,
      status: "paid",
      currency_code: "INR",
      provider: "primary",
      order_id: "ORD-1",
    });
  });

  it("**a historical Zoho invoice keeps provider 'zoho'** — it is not relabelled as a primary-engine document", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    listInvoiceOrdersAdmin.mockResolvedValueOnce({
      orders: [order({ orderId: "ORD-OLD", invoiceProvider: "zoho", invoiceNumber: "INV-000123" })],
      hasMore: false,
      total: 1,
    });
    const body = await (await GET(makeReq())).json();
    expect(body.invoices[0].provider).toBe("zoho");
    expect(body.invoices[0].invoice_id).toBe("ORD-OLD");
    expect(body.invoices[0].invoice_number).toBe("INV-000123");
  });

  it("unpaid order → balance is the full amount, status mapped from the Order status", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    listInvoiceOrdersAdmin.mockResolvedValueOnce({
      orders: [order({ status: "pending" })],
      hasMore: false,
      total: 1,
    });
    const body = await (await GET(makeReq())).json();
    expect(body.invoices[0].status).toBe("sent");
    expect(body.invoices[0].balance).toBe(1180);
  });

  it("unknown Order status → 'draft' rather than undefined", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    listInvoiceOrdersAdmin.mockResolvedValueOnce({
      orders: [order({ status: "some_new_status" })],
      hasMore: false,
      total: 1,
    });
    const body = await (await GET(makeReq())).json();
    expect(body.invoices[0].status).toBe("draft");
  });

  it("falls back to the email when the Order has no userName", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    listInvoiceOrdersAdmin.mockResolvedValueOnce({
      orders: [order({ userName: undefined })],
      hasMore: false,
      total: 1,
    });
    const body = await (await GET(makeReq())).json();
    expect(body.invoices[0].customer_name).toBe("alice@example.com");
  });

  it("missing currency → 'INR'", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    listInvoiceOrdersAdmin.mockResolvedValueOnce({
      orders: [order({ currency: undefined })],
      hasMore: false,
      total: 1,
    });
    const body = await (await GET(makeReq())).json();
    expect(body.invoices[0].currency_code).toBe("INR");
  });
});

describe("page_context", () => {
  it("carries page, per_page, has_more_page and the service's real total", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    listInvoiceOrdersAdmin.mockResolvedValueOnce({
      orders: [order()],
      hasMore: true,
      total: 42,
    });
    const body = await (await GET(makeReq("page=2&per_page=10"))).json();
    expect(body.page_context).toEqual({
      page: 2,
      per_page: 10,
      has_more_page: true,
      total: 42,
    });
    expect(listInvoiceOrdersAdmin).toHaveBeenCalledWith(2, 10);
  });
});

describe("Outer catch", () => {
  it("DB throw → 500 'Failed to fetch invoices' (no leak)", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    listInvoiceOrdersAdmin.mockRejectedValueOnce(
      new Error("Mongo timeout at cluster0-shard-2.mongodb.net")
    );
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch invoices");
    expect(body.error).not.toContain("mongodb.net");
  });
});
