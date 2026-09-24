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
 *  - invoice_failed = paid && !issued && invoiceFailedAt — the only state
 *    that offers the customer a retry
 *  - No `provider` / `zoho_pending` fields any more
 *  - balance: 0 for paid orders, full amount otherwise
 *  - **Self-heal**: runs ONLY when some row is invoice_failed. An issued
 *    order (primary OR historical zoho) never triggers it — that would be
 *    a second tax invoice for one payment. Re-fetch only if a retry
 *    recovered something.
 *  - Outer catch → 500 'Internal Server Error'
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const listUserInvoiceOrders = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({ listUserInvoiceOrders }));

const selfHealUserInvoices = vi.hoisted(() => vi.fn());
vi.mock("@/lib/invoice-retry", () => ({ selfHealUserInvoices }));

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
  selfHealUserInvoices.mockReset().mockResolvedValue([]);
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
      invoice_failed: false,
    });
  });

  it("a historical Zoho-issued invoice is also 'issued' — invoice_id is the orderId, not a Zoho id", async () => {
    listUserInvoiceOrders.mockResolvedValueOnce([
      order({ invoiceProvider: "zoho", invoiceNumber: "INV-000123" }),
    ]);
    const body = await (await GET(makeReq())).json();
    expect(body.invoices[0].invoice_id).toBe("ORD-1");
    expect(body.invoices[0].invoice_number).toBe("INV-000123");
    expect(body.invoices[0].invoice_failed).toBe(false);
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

describe("invoice_failed", () => {
  it("paid + not issued + invoiceFailedAt → true", async () => {
    listUserInvoiceOrders.mockResolvedValueOnce([failedOrder()]);
    const body = await (await GET(makeReq())).json();
    expect(body.invoices[0].invoice_failed).toBe(true);
    expect(body.invoices[0].invoice_id).toBe("");
  });

  it("paid + not issued + NO invoiceFailedAt → false (no known failure; nothing to retry)", async () => {
    listUserInvoiceOrders.mockResolvedValueOnce([
      failedOrder({ invoiceFailedAt: undefined }),
    ]);
    const body = await (await GET(makeReq())).json();
    expect(body.invoices[0].invoice_failed).toBe(false);
  });

  it("UNPAID + invoiceFailedAt → false (unpaid orders are never invoiced)", async () => {
    listUserInvoiceOrders.mockResolvedValueOnce([failedOrder({ status: "pending" })]);
    const body = await (await GET(makeReq())).json();
    expect(body.invoices[0].invoice_failed).toBe(false);
  });

  it("issued + a stale invoiceFailedAt from an earlier attempt → false (the invoice exists)", async () => {
    listUserInvoiceOrders.mockResolvedValueOnce([
      order({ invoiceFailedAt: new Date("2026-06-01T10:05:00.000Z") }),
    ]);
    const body = await (await GET(makeReq())).json();
    expect(body.invoices[0].invoice_failed).toBe(false);
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

describe("Self-heal flow (a failed row → inline retry)", () => {
  it("failed row → selfHealUserInvoices(userId); a recovery → re-fetch + re-map", async () => {
    listUserInvoiceOrders
      .mockResolvedValueOnce([failedOrder()])
      .mockResolvedValueOnce([order({ invoiceNumber: "TI/2026-27/00002" })]);
    selfHealUserInvoices.mockResolvedValueOnce([{ orderId: "ORD-1", ok: true }]);

    const res = await GET(makeReq());
    expect(selfHealUserInvoices).toHaveBeenCalledWith("U1");
    expect(listUserInvoiceOrders).toHaveBeenCalledTimes(2);
    const body = await res.json();
    expect(body.invoices[0].invoice_id).toBe("ORD-1");
    expect(body.invoices[0].invoice_number).toBe("TI/2026-27/00002");
    expect(body.invoices[0].invoice_failed).toBe(false);
  });

  it("self-heal recovers nothing → NO re-fetch; the failed row is still reported failed", async () => {
    listUserInvoiceOrders.mockResolvedValueOnce([failedOrder()]);
    selfHealUserInvoices.mockResolvedValueOnce([
      { orderId: "ORD-1", ok: false, skipped: "throttled" },
    ]);

    const res = await GET(makeReq());
    expect(listUserInvoiceOrders).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.invoices[0].invoice_id).toBe("");
    expect(body.invoices[0].invoice_failed).toBe(true);
  });

  it.each(["primary", "zoho"])(
    "**an issued (%s) invoice never triggers self-heal** — a retry there would be a second tax invoice for one payment",
    async (provider) => {
      listUserInvoiceOrders.mockResolvedValueOnce([order({ invoiceProvider: provider })]);
      await GET(makeReq());
      expect(selfHealUserInvoices).not.toHaveBeenCalled();
    }
  );

  it("paid, not issued, no recorded failure → self-heal NOT called (it only retries known failures)", async () => {
    listUserInvoiceOrders.mockResolvedValueOnce([failedOrder({ invoiceFailedAt: undefined })]);
    await GET(makeReq());
    expect(selfHealUserInvoices).not.toHaveBeenCalled();
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
