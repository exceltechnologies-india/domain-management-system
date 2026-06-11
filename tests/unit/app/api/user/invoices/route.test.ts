/**
 * Tests for `app/api/user/invoices/route.ts` (slice 7hc, part 1).
 * Customer's invoice list. The interesting pin is the **self-heal
 * flow**: if any paid orders are missing a real Zoho invoice id
 * (because the bookkeeping step crashed on Zoho's end), this route
 * INLINE-retries invoice creation, then re-fetches the list before
 * returning. Inline because Cloud Run throttles CPU after the
 * response is sent, so fire-and-forget promises die.
 *
 * Pins:
 *  - Auth → 401 (NO listing call)
 *  - listUserInvoiceOrders scoped on user._id
 *  - **Order-status → invoice-status mapping** pinned VERBATIM:
 *      completed/paid → paid
 *      pending/processing → sent
 *      failed/refunded → void
 *      anything else → draft
 *  - **Sentinel-id filter**: zohoInvoiceId in {'pending_creation',
 *    'creation_failed'} → invoice_id becomes '' (empty string;
 *    not the sentinel value); `zoho_pending` flag flipped to true
 *    so UI can show 'Generating invoice…'
 *  - balance: 0 for paid orders, full amount otherwise
 *  - **Self-heal**: hasStuck=true (a paid order with empty
 *    invoice_id) triggers selfHealUserInvoices. ONLY if any
 *    retry returns ok=true does the route re-fetch + re-map.
 *    If none recovered, the original empty list is returned
 *    (cheaper than a pointless second DB read).
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
vi.mock("@/lib/zoho-invoice-retry", () => ({ selfHealUserInvoices }));

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
    zohoInvoiceId: "zoho-real-id",
    invoiceNumber: "INV-2026-00001",
    amount: 999,
    status: "completed",
    currency: "INR",
    createdAt: new Date("2026-06-01T10:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(user);
  listUserInvoiceOrders.mockReset();
  selfHealUserInvoices.mockReset();
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
    listUserInvoiceOrders.mockResolvedValueOnce([
      order({ status: orderStatus }),
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.invoices[0].status).toBe(expected);
  });
});

describe("Sentinel-id filter", () => {
  it.each(["pending_creation", "creation_failed"])(
    "zohoInvoiceId=%p on paid order → invoice_id is empty string, zoho_pending:true",
    async (sentinel) => {
      listUserInvoiceOrders.mockResolvedValueOnce([
        order({ zohoInvoiceId: sentinel, status: "completed" }),
      ]);
      // No self-heal stuck-recovery; just verify the sentinel is filtered out
      selfHealUserInvoices.mockResolvedValueOnce([]);

      const res = await GET(makeReq());
      const body = await res.json();
      expect(body.invoices[0].invoice_id).toBe("");
      expect(body.invoices[0].zoho_pending).toBe(true);
    }
  );

  it("real Zoho id → invoice_id passes through, zoho_pending:false", async () => {
    listUserInvoiceOrders.mockResolvedValueOnce([
      order({ zohoInvoiceId: "zoho-real-id", status: "completed" }),
    ]);

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.invoices[0].invoice_id).toBe("zoho-real-id");
    expect(body.invoices[0].zoho_pending).toBe(false);
  });

  it("missing zohoInvoiceId on UNPAID order → empty invoice_id but zoho_pending:false (no Zoho retry expected for unpaid)", async () => {
    listUserInvoiceOrders.mockResolvedValueOnce([
      order({ zohoInvoiceId: undefined, status: "pending" }),
    ]);

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.invoices[0].invoice_id).toBe("");
    // zoho_pending only true when isPaid; pending order isn't paid
    expect(body.invoices[0].zoho_pending).toBe(false);
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

describe("Self-heal flow (hasStuck → inline retry)", () => {
  it("paid order with empty invoice_id → selfHealUserInvoices called; if any recover → re-fetch + re-map", async () => {
    const stuckOrder = order({
      zohoInvoiceId: "pending_creation",
      status: "completed",
    });
    const recoveredOrder = order({
      zohoInvoiceId: "zoho-now-real",
      status: "completed",
    });

    listUserInvoiceOrders
      .mockResolvedValueOnce([stuckOrder])
      .mockResolvedValueOnce([recoveredOrder]);
    selfHealUserInvoices.mockResolvedValueOnce([
      { orderId: "ORD-1", ok: true },
    ]);

    const res = await GET(makeReq());
    expect(selfHealUserInvoices).toHaveBeenCalledWith("U1");
    expect(listUserInvoiceOrders).toHaveBeenCalledTimes(2);
    const body = await res.json();
    expect(body.invoices[0].invoice_id).toBe("zoho-now-real");
    expect(body.invoices[0].zoho_pending).toBe(false);
  });

  it("self-heal recovers nothing → NO re-fetch (skip the second DB round-trip)", async () => {
    listUserInvoiceOrders.mockResolvedValueOnce([
      order({ zohoInvoiceId: "pending_creation", status: "completed" }),
    ]);
    selfHealUserInvoices.mockResolvedValueOnce([
      { orderId: "ORD-1", ok: false, skipped: true },
    ]);

    const res = await GET(makeReq());
    expect(listUserInvoiceOrders).toHaveBeenCalledTimes(1);
    const body = await res.json();
    // Original empty invoice_id returned
    expect(body.invoices[0].invoice_id).toBe("");
    expect(body.invoices[0].zoho_pending).toBe(true);
  });

  it("no stuck orders → selfHealUserInvoices NOT called (no Zoho hit on normal page-load)", async () => {
    listUserInvoiceOrders.mockResolvedValueOnce([
      order({ zohoInvoiceId: "zoho-real-id", status: "completed" }),
    ]);
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
