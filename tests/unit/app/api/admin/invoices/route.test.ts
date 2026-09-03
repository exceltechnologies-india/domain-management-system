/**
 * Tests for `app/api/admin/invoices/route.ts` (slice 7gq, part 3).
 * Admin Zoho Books invoice listing (passthrough). The interesting
 * pin is the parseInt-without-clamp on page / per_page (a regression
 * here would let `?per_page=garbage` reach Zoho as NaN).
 *
 * Pins:
 *  - connectDB BEFORE auth (same pattern as 7gp ip-status)
 *  - Admin gate via getAdminFromRequest → 401 'Unauthorized'
 *  - Query parsing:
 *      - page default '1' → parseInt → 1
 *      - per_page default '20' → parseInt → 20
 *      - parseInt no radix arg — current source uses `parseInt(s || '1')`
 *  - **parseInt-without-Number.isFinite quirk**: `?page=abc` →
 *    parseInt('abc') === NaN → reaches ZohoBooksService as NaN.
 *    Pinned alongside the 7go support-tickets variant for the
 *    harmony audit.
 *  - ZohoBooksService.getInstance().getAllInvoices(page, perPage)
 *  - Response: { success:true, invoices, page_context } — Zoho's
 *    page_context object passed through verbatim; rows stamped
 *    with provider:'zoho'
 *  - **?source=primary**: reads primary-engine invoices from the
 *    local DB instead of Zoho (they exist ONLY here — Zoho never
 *    sees them, so before this they were invisible to the admin).
 *    Mapped to the same row shape; invoice_id deliberately empty,
 *    order_id carries the key. Only an exact 'primary' opts in.
 *  - Outer catch → 500 'Failed to fetch invoices' (no leak)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const connectDB = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

const listPrimaryInvoiceOrdersAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({ listPrimaryInvoiceOrdersAdmin }));

const getAllInvoices = vi.hoisted(() => vi.fn());
const getInstance = vi.hoisted(() => vi.fn(() => ({ getAllInvoices })));
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

import { GET } from "@/app/api/admin/invoices/route";

function makeReq(qs = "") {
  const url = qs
    ? `https://example.com/api/admin/invoices?${qs}`
    : "https://example.com/api/admin/invoices";
  return new NextRequest(url, { method: "GET" });
}

beforeEach(() => {
  getAdminFromRequest.mockReset();
  connectDB.mockClear().mockResolvedValue(undefined);
  getAllInvoices.mockReset();
  listPrimaryInvoiceOrdersAdmin.mockReset();
});

describe("connectDB ordering", () => {
  it("connectDB called BEFORE the auth gate (current source order — pinned)", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    await GET(makeReq());
    expect(connectDB).toHaveBeenCalled();
  });
});

describe("Admin gate", () => {
  it("non-admin → 401 'Unauthorized'; NO Zoho call", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
    expect(getAllInvoices).not.toHaveBeenCalled();
  });
});

describe("Query parsing — defaults", () => {
  it("no query params → getAllInvoices(1, 20)", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    getAllInvoices.mockResolvedValueOnce({
      invoices: [],
      page_context: { page: 1, per_page: 20, total: 0 },
    });
    await GET(makeReq());
    expect(getAllInvoices).toHaveBeenCalledWith(1, 20);
  });

  it("?page=3&per_page=50 → getAllInvoices(3, 50)", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    getAllInvoices.mockResolvedValueOnce({
      invoices: [],
      page_context: {},
    });
    await GET(makeReq("page=3&per_page=50"));
    expect(getAllInvoices).toHaveBeenCalledWith(3, 50);
  });
});

describe("Query parsing — NaN quirk pinned", () => {
  it("?page=abc&per_page=xyz → parseInt yields NaN → NaN reaches Zoho (current behaviour, paired with 7go quirk)", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    getAllInvoices.mockResolvedValueOnce({
      invoices: [],
      page_context: {},
    });
    await GET(makeReq("page=abc&per_page=xyz"));
    // Pinned. A Number.isFinite() guard would change these to 1 and 20.
    expect(getAllInvoices).toHaveBeenCalledWith(NaN, NaN);
  });
});

describe("Response passthrough", () => {
  it("returns { success:true, invoices, page_context } passing through Zoho's page_context shape", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    getAllInvoices.mockResolvedValueOnce({
      invoices: [{ invoice_id: "INV-1", total: 999 }],
      page_context: {
        page: 1,
        per_page: 20,
        has_more_page: true,
        total: 42,
      },
    });
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      // Rows are stamped with `provider` so the client can route actions
      // uniformly across both tabs rather than inferring from an empty id.
      // Everything else still passes through verbatim.
      invoices: [{ invoice_id: "INV-1", total: 999, provider: "zoho" }],
      page_context: {
        page: 1,
        per_page: 20,
        has_more_page: true,
        total: 42,
      },
    });
  });
});

describe("source=primary — invoices the Zoho passthrough can't see", () => {
  const primaryOrder = (o: Record<string, unknown> = {}) => ({
    orderId: "ORD-1",
    invoiceNumber: "TI/2026-27/00001",
    userName: "Alice Anderson",
    userEmail: "alice@example.com",
    amount: 1180,
    currency: "INR",
    status: "completed",
    createdAt: new Date("2026-09-01T10:00:00.000Z"),
    ...o,
  });

  it("**?source=primary reads the local DB and never touches Zoho**", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    listPrimaryInvoiceOrdersAdmin.mockResolvedValueOnce({
      orders: [primaryOrder()],
      hasMore: false,
    });
    const res = await GET(makeReq("source=primary"));
    expect(res.status).toBe(200);
    expect(listPrimaryInvoiceOrdersAdmin).toHaveBeenCalledWith(1, 20);
    expect(getAllInvoices).not.toHaveBeenCalled();
  });

  it("maps an Order to the same row shape the Zoho tab renders", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    listPrimaryInvoiceOrdersAdmin.mockResolvedValueOnce({
      orders: [primaryOrder()],
      hasMore: false,
    });
    const res = await GET(makeReq("source=primary"));
    const body = await res.json();
    expect(body.invoices[0]).toEqual({
      invoice_id: "",
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

  it("**invoice_id is empty and order_id carries the key** — a primary invoice has no Zoho id, so anything keying off invoice_id must fail visibly rather than fetch the wrong document", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    listPrimaryInvoiceOrdersAdmin.mockResolvedValueOnce({
      orders: [primaryOrder()],
      hasMore: false,
    });
    const body = await (await GET(makeReq("source=primary"))).json();
    expect(body.invoices[0].invoice_id).toBe("");
    expect(body.invoices[0].order_id).toBe("ORD-1");
  });

  it("unpaid order → balance is the full amount, status mapped from the Order status", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    listPrimaryInvoiceOrdersAdmin.mockResolvedValueOnce({
      orders: [primaryOrder({ status: "pending" })],
      hasMore: false,
    });
    const body = await (await GET(makeReq("source=primary"))).json();
    expect(body.invoices[0].status).toBe("sent");
    expect(body.invoices[0].balance).toBe(1180);
  });

  it("unknown Order status → 'draft' rather than undefined", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    listPrimaryInvoiceOrdersAdmin.mockResolvedValueOnce({
      orders: [primaryOrder({ status: "some_new_status" })],
      hasMore: false,
    });
    const body = await (await GET(makeReq("source=primary"))).json();
    expect(body.invoices[0].status).toBe("draft");
  });

  it("falls back to the email when the Order has no userName", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    listPrimaryInvoiceOrdersAdmin.mockResolvedValueOnce({
      orders: [primaryOrder({ userName: undefined })],
      hasMore: false,
    });
    const body = await (await GET(makeReq("source=primary"))).json();
    expect(body.invoices[0].customer_name).toBe("alice@example.com");
  });

  it("hasMore is surfaced as page_context.has_more_page, matching the Zoho contract the page already consumes", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    listPrimaryInvoiceOrdersAdmin.mockResolvedValueOnce({
      orders: [primaryOrder()],
      hasMore: true,
    });
    const body = await (await GET(makeReq("source=primary&page=2&per_page=10"))).json();
    expect(body.page_context).toEqual({
      page: 2,
      per_page: 10,
      has_more_page: true,
    });
    expect(listPrimaryInvoiceOrdersAdmin).toHaveBeenCalledWith(2, 10);
  });

  it("admin gate applies to the primary source too — 401 and no DB read", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq("source=primary"));
    expect(res.status).toBe(401);
    expect(listPrimaryInvoiceOrdersAdmin).not.toHaveBeenCalled();
  });

  it("DB throw → same non-leaking 500 as the Zoho branch", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    listPrimaryInvoiceOrdersAdmin.mockRejectedValueOnce(
      new Error("Mongo timeout at cluster0-shard-2.mongodb.net")
    );
    const res = await GET(makeReq("source=primary"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch invoices");
    expect(body.error).not.toContain("mongodb.net");
  });
});

describe("source routing — the Zoho default is preserved", () => {
  it.each(["", "source=zoho", "source=bogus", "source=PRIMARY"])(
    "%o → Zoho branch (only an exact 'primary' opts in, so older clients are unaffected)",
    async (qs) => {
      getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
      getAllInvoices.mockResolvedValueOnce({ invoices: [], page_context: {} });
      await GET(makeReq(qs));
      expect(getAllInvoices).toHaveBeenCalledTimes(1);
      expect(listPrimaryInvoiceOrdersAdmin).not.toHaveBeenCalled();
    }
  );
});

describe("Outer catch", () => {
  it("Zoho throw → 500 'Failed to fetch invoices' (no leak)", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    getAllInvoices.mockRejectedValueOnce(
      new Error("Zoho 429: rate limited at org=12345")
    );
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch invoices");
    expect(body.error).not.toContain("Zoho");
    expect(body.error).not.toContain("12345");
  });
});
