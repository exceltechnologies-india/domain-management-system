/**
 * Tests for `app/api/user/invoices/route.ts`.
 *
 * Customer's invoice list. Since Zoho Books was removed (24 Sep 2026) an
 * order is "issued" iff it has an `invoiceProvider` ('primary', or a
 * historical 'zoho'), and DMS renders every PDF from the order by orderId.
 *
 * Pins:
 *  - Auth → 401 (NO listing call)
 *  - listUserInvoiceOrders scoped on user._id
 *  - **Order-status → invoice-status mapping** pinned VERBATIM:
 *      completed/paid → paid; pending/processing → sent;
 *      failed/refunded → void; anything else → draft
 *  - invoice_id = orderId ONLY when invoiceProvider is set; '' otherwise
 *  - no invoice_failed field and no retry (DMS issues no bills since 25 Sep 2026)
 *  - No `provider` / `zoho_pending` fields any more
 *  - balance: 0 for paid orders, full amount otherwise
 *  - Outer catch → 500 'Internal Server Error'
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const listUserInvoiceOrders = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({ listUserInvoiceOrders }));


vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/user/invoices/route";

function makeReq() {
  return new NextRequest("https://example.com/api/user/invoices", {
    method: "GET",
  });
}

const user = { _id: "U1", email: "alice@example.com" };

function order(overrides: Record<string, unknown> = {}) {
  return {
    orderId: "ORD-1",
    invoiceProvider: "primary",
    invoiceNumber: "TI/2026-27/00001",
    amount: 999,
    status: "completed",
    currency: "INR",
    createdAt: new Date("2026-06-01T10:00:00.000Z"),
    ...overrides,
  };
}

const failedOrder = (o: Record<string, unknown> = {}) =>
  order({
    invoiceProvider: undefined,
    invoiceNumber: undefined,
    invoiceFailedAt: new Date("2026-06-01T10:05:00.000Z"),
    ...o,
  });

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(user);
  listUserInvoiceOrders.mockReset();
});

describe("Auth gate", () => {
  it("no user → 401; NO listing call", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    expect(listUserInvoiceOrders).not.toHaveBeenCalled();
  });
});

describe("IDOR scope", () => {
  it("listUserInvoiceOrders called with user._id", async () => {
    listUserInvoiceOrders.mockResolvedValueOnce([]);
    await GET(makeReq());
    expect(listUserInvoiceOrders).toHaveBeenCalledWith("U1");
  });
});

describe("Order-status → invoice-status mapping", () => {
  it.each([
    ["completed", "paid"],
    ["paid", "paid"],
    ["pending", "sent"],
    ["processing", "sent"],
    ["failed", "void"],
    ["refunded", "void"],
    ["unknown_status", "draft"], // fallback
  ])("status=%p → invoice status=%p", async (orderStatus, expected) => {
    listUserInvoiceOrders.mockResolvedValueOnce([order({ status: orderStatus })]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.invoices[0].status).toBe(expected);
  });
});

describe("Row shape", () => {
  it("issued primary invoice → full row; invoice_id is the orderId; no provider / zoho_pending fields", async () => {
    listUserInvoiceOrders.mockResolvedValueOnce([order()]);
    const body = await (await GET(makeReq())).json();
    expect(body.invoices[0]).toEqual({
      invoice_id: "ORD-1",
      invoice_number: "TI/2026-27/00001",
      date: "2026-06-01T10:00:00.000Z",
      due_date: "2026-06-01T10:00:00.000Z",
      total: 999,
      balance: 0,
      status: "paid",
      currency_code: "INR",
      created_time: "2026-06-01T10:00:00.000Z",
      order_id: "ORD-1",
    });
  });

  it("a historical Zoho-issued invoice is also 'issued' — invoice_id is the orderId, not a Zoho id", async () => {
    listUserInvoiceOrders.mockResolvedValueOnce([
      order({ invoiceProvider: "zoho", invoiceNumber: "INV-000123" }),
    ]);
    const body = await (await GET(makeReq())).json();
    expect(body.invoices[0].invoice_id).toBe("ORD-1");
    expect(body.invoices[0].invoice_number).toBe("INV-000123");
  });

  it("no invoiceProvider → invoice_id is '' (nothing to download yet)", async () => {
    listUserInvoiceOrders.mockResolvedValueOnce([
      order({ invoiceProvider: undefined, status: "pending" }),
    ]);
    const body = await (await GET(makeReq())).json();
    expect(body.invoices[0].invoice_id).toBe("");
    expect(body.invoices[0].order_id).toBe("ORD-1");
  });
});

// Since 25 Sep 2026 DMS issues no bills, so there is no retry: no row carries
// invoice_failed and nothing re-issues an invoice while the list is read.
describe("No retry", () => {
  it("a paid, uninvoiced, flagged order is listed with no document and no retry field", async () => {
    listUserInvoiceOrders.mockResolvedValueOnce([failedOrder()]);
    const body = await (await GET(makeReq())).json();
    expect(body.invoices[0].invoice_id).toBe("");
    expect(body.invoices[0]).not.toHaveProperty("invoice_failed");
    expect(listUserInvoiceOrders).toHaveBeenCalledTimes(1);
  });
});

describe("Balance computation", () => {
  it("paid → balance:0; unpaid → balance:amount", async () => {
    listUserInvoiceOrders.mockResolvedValueOnce([
      order({ amount: 999, status: "completed" }),
      order({ amount: 555, status: "pending" }),
    ]);
    const body = await (await GET(makeReq())).json();
    expect(body.invoices[0].balance).toBe(0);
    expect(body.invoices[1].balance).toBe(555);
  });
});

describe("Outer catch", () => {
  it("listUserInvoiceOrders throw → 500 'Internal Server Error' (no leak)", async () => {
    listUserInvoiceOrders.mockRejectedValueOnce(new Error("Mongo timeout"));
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal Server Error");
    expect(body.error).not.toContain("Mongo");
  });
});
