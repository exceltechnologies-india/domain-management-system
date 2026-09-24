/**
 * Tests for `app/api/admin/orders/[id]/re-sync-invoice/route.ts`.
 *
 * Admin "issue the invoice now" for a paid order that has none. Since Zoho
 * Books was removed (24 Sep 2026) the route goes through `createPrimaryInvoice`
 * — the same chokepoint as every other invoicing call site — instead of
 * calling Zoho directly.
 *
 * Pins:
 *  - Admin gate via getAdminFromRequest → 401, no order lookup
 *  - getOrderByIdOrOrderId accepts either DB _id OR orderId
 *  - Order not found → 404 'Order not found'
 *  - **Double-billing guard**: ANY invoiceProvider — 'primary' (our engine)
 *    or 'zoho' (historical) — means the payment already has a tax invoice.
 *    → 409 code INVOICE_EXISTS, and createPrimaryInvoice is NEVER called
 *    (nor is the user even looked up).
 *  - getUserById null → 404 'Associated user not found'
 *  - createPrimaryInvoice called with the order context and
 *    claimOptions.staleClaimAfterMs = 5 min
 *  - provider 'skipped' → 409 success:false (₹0/trial or in-flight claim)
 *  - Success → 200 with invoice_id = orderId, invoice_number
 *  - createPrimaryInvoice throw → markInvoiceCreationFailed(order._id,
 *    message) then 500 with the reason and what to do
 *  - Outer catch leaks error.message (family quirk — pinned)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const getOrderByIdOrOrderId = vi.hoisted(() => vi.fn());
const markInvoiceCreationFailed = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  getOrderByIdOrOrderId,
  markInvoiceCreationFailed,
}));

const getUserById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserById }));

const createPrimaryInvoice = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/billing/createPrimaryInvoice", () => ({
  createPrimaryInvoice,
}));

const cartItemsFromOrderDomains = vi.hoisted(() =>
  vi.fn((domains: Array<Record<string, unknown>>) =>
    domains.map((d) => ({ domainName: d.domainName, price: d.price, itemType: d.itemType }))
  )
);
vi.mock("@/lib/services/payment/order-creator", () => ({
  cartItemsFromOrderDomains,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/admin/orders/[id]/re-sync-invoice/route";

function makeReq() {
  return new NextRequest(
    "https://example.com/api/admin/orders/ORD-1/re-sync-invoice",
    { method: "POST" }
  );
}

function paramsOf(id: string) {
  return { params: Promise.resolve({ id }) };
}

const admin = { _id: "A1", email: "admin@example.com" };
const userRow = {
  _id: "U1",
  email: "alice@example.com",
  firstName: "Alice",
  lastName: "Anderson",
};

function freshOrder(overrides: Record<string, unknown> = {}) {
  return {
    _id: "ORD_INTERNAL_ID",
    orderId: "ORD-USER-FACING",
    userId: "U1",
    amount: 1500,
    currency: "INR",
    razorpayPaymentId: "pay_REAL",
    paymentId: "pay_LEGACY",
    domains: [
      {
        itemType: "domain",
        domainName: "example.com",
        price: 1500,
        registrationPeriod: 1,
        periodUnit: "years",
      },
    ],
    invoiceProvider: undefined,
    invoiceNumber: undefined,
    ...overrides,
  };
}

beforeEach(() => {
  getAdminFromRequest.mockReset().mockResolvedValue(admin);
  getOrderByIdOrOrderId.mockReset();
  getUserById.mockReset();
  createPrimaryInvoice.mockReset();
  markInvoiceCreationFailed.mockReset().mockResolvedValue(undefined);
  cartItemsFromOrderDomains.mockClear();
});

describe("Admin gate", () => {
  it("non-admin → 401; NO order lookup, NO invoice", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(401);
    expect(getOrderByIdOrOrderId).not.toHaveBeenCalled();
    expect(createPrimaryInvoice).not.toHaveBeenCalled();
  });
});

describe("Order + user lookup", () => {
  it("getOrderByIdOrOrderId called with the route id (accepts _id OR orderId)", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(null);
    await POST(makeReq(), paramsOf("ORD-USER-FACING"));
    expect(getOrderByIdOrOrderId).toHaveBeenCalledWith("ORD-USER-FACING");
  });

  it("order not found → 404 'Order not found'", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(null);
    const res = await POST(makeReq(), paramsOf("ORD-MISSING"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Order not found");
    expect(getUserById).not.toHaveBeenCalled();
    expect(createPrimaryInvoice).not.toHaveBeenCalled();
  });

  it("user not found → 404 'Associated user not found'; NO invoice", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(freshOrder());
    getUserById.mockResolvedValueOnce(null);
    const res = await POST(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Associated user not found");
    expect(createPrimaryInvoice).not.toHaveBeenCalled();
  });

  it("getUserById is called with String(order.userId)", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(
      freshOrder({ userId: { toString: () => "U-OBJ" } })
    );
    getUserById.mockResolvedValueOnce(null);
    await POST(makeReq(), paramsOf("ORD-1"));
    expect(getUserById).toHaveBeenCalledWith("U-OBJ");
  });
});

describe("**Double-billing guard** — an already-invoiced order is refused", () => {
  it.each(["primary", "zoho"] as const)(
    "invoiceProvider '%s' → 409 INVOICE_EXISTS; createPrimaryInvoice NOT called",
    async (provider) => {
      getOrderByIdOrOrderId.mockResolvedValueOnce(
        freshOrder({ invoiceProvider: provider, invoiceNumber: "TI/2026-27/00042" })
      );
      const res = await POST(makeReq(), paramsOf("ORD-1"));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe("INVOICE_EXISTS");
      expect(body.invoiceProvider).toBe(provider);
      expect(body.invoice_number).toBe("TI/2026-27/00042");
      expect(body.error).toContain("already has a tax invoice (TI/2026-27/00042)");
      expect(body.error).toContain("bill the same payment twice");
      expect(createPrimaryInvoice).not.toHaveBeenCalled();
      expect(getUserById).not.toHaveBeenCalled();
      expect(markInvoiceCreationFailed).not.toHaveBeenCalled();
    }
  );

  it("provider set but no number recorded → still refused; message omits the parenthetical", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(
      freshOrder({ invoiceProvider: "zoho", invoiceNumber: undefined })
    );
    const res = await POST(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("INVOICE_EXISTS");
    expect(body.error).toContain("already has a tax invoice. ");
    expect(createPrimaryInvoice).not.toHaveBeenCalled();
  });
});

describe("Issuing through createPrimaryInvoice", () => {
  it("called with the order context and a 5-minute stale-claim window", async () => {
    const order = freshOrder();
    getOrderByIdOrOrderId.mockResolvedValueOnce(order);
    getUserById.mockResolvedValueOnce(userRow);
    createPrimaryInvoice.mockResolvedValueOnce({
      invoiceId: "x",
      invoiceNumber: "TI/2026-27/00007",
      provider: "primary",
    });
    await POST(makeReq(), paramsOf("ORD-1"));
    expect(createPrimaryInvoice).toHaveBeenCalledTimes(1);
    const [ctx, opts] = createPrimaryInvoice.mock.calls[0];
    expect(ctx.order).toBe(order);
    expect(ctx.orderId).toBe("ORD-USER-FACING");
    expect(ctx.razorpay_payment_id).toBe("pay_REAL");
    expect(ctx.paymentDetails).toEqual({ id: "pay_REAL", amount: 1500, currency: "INR" });
    expect(ctx.user).toBe(userRow);
    expect(ctx.cartItems).toEqual([
      { domainName: "example.com", price: 1500, itemType: "domain" },
    ]);
    expect(cartItemsFromOrderDomains).toHaveBeenCalledWith(order.domains);
    expect(opts).toEqual({ claimOptions: { staleClaimAfterMs: 5 * 60 * 1000 } });
  });

  it("falls back to paymentId, then '' when razorpayPaymentId is missing", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(freshOrder({ razorpayPaymentId: undefined }));
    getUserById.mockResolvedValueOnce(userRow);
    createPrimaryInvoice.mockResolvedValueOnce({ invoiceId: "", invoiceNumber: "N", provider: "primary" });
    await POST(makeReq(), paramsOf("ORD-1"));
    expect(createPrimaryInvoice.mock.calls[0][0].razorpay_payment_id).toBe("pay_LEGACY");

    getOrderByIdOrOrderId.mockResolvedValueOnce(
      freshOrder({ razorpayPaymentId: undefined, paymentId: undefined, currency: undefined })
    );
    getUserById.mockResolvedValueOnce(userRow);
    createPrimaryInvoice.mockResolvedValueOnce({ invoiceId: "", invoiceNumber: "N", provider: "primary" });
    await POST(makeReq(), paramsOf("ORD-1"));
    expect(createPrimaryInvoice.mock.calls[1][0].razorpay_payment_id).toBe("");
    expect(createPrimaryInvoice.mock.calls[1][0].paymentDetails.currency).toBe("INR");
  });

  it("success → 200 with invoice_id = orderId and the engine's invoice number", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(freshOrder());
    getUserById.mockResolvedValueOnce(userRow);
    createPrimaryInvoice.mockResolvedValueOnce({
      invoiceId: "x",
      invoiceNumber: "TI/2026-27/00007",
      provider: "primary",
    });
    const res = await POST(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      message: "Invoice TI/2026-27/00007 issued",
      invoice_id: "ORD-USER-FACING",
      invoice_number: "TI/2026-27/00007",
    });
    expect(markInvoiceCreationFailed).not.toHaveBeenCalled();
  });

  it("provider 'skipped' → 409 success:false with the reason; not recorded as a failure", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(freshOrder());
    getUserById.mockResolvedValueOnce(userRow);
    createPrimaryInvoice.mockResolvedValueOnce({
      invoiceId: "",
      invoiceNumber: null,
      provider: "skipped",
    });
    const res = await POST(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain("No invoice was issued");
    expect(markInvoiceCreationFailed).not.toHaveBeenCalled();
  });

  it("createPrimaryInvoice throws → markInvoiceCreationFailed(order._id, message) then 500 naming the cause", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(freshOrder());
    getUserById.mockResolvedValueOnce(userRow);
    createPrimaryInvoice.mockRejectedValueOnce(new Error("COMPANY_STATE is not configured"));
    const res = await POST(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(500);
    expect(markInvoiceCreationFailed).toHaveBeenCalledWith(
      "ORD_INTERNAL_ID",
      "COMPANY_STATE is not configured"
    );
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain("could not be issued: COMPANY_STATE is not configured");
    expect(body.error).toContain("press Re-sync again");
  });

  it("markInvoiceCreationFailed itself rejecting does not mask the 500", async () => {
    getOrderByIdOrOrderId.mockResolvedValueOnce(freshOrder());
    getUserById.mockResolvedValueOnce(userRow);
    createPrimaryInvoice.mockRejectedValueOnce(new Error("boom"));
    markInvoiceCreationFailed.mockRejectedValueOnce(new Error("db down"));
    const res = await POST(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("could not be issued: boom");
  });
});

describe("Outer catch", () => {
  it("getOrderByIdOrOrderId throw → 500 with err.message (family quirk: raw leak)", async () => {
    getOrderByIdOrOrderId.mockRejectedValueOnce(new Error("mongo exploded LEAK_ME"));
    const res = await POST(makeReq(), paramsOf("ORD-1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("LEAK_ME");
    expect(createPrimaryInvoice).not.toHaveBeenCalled();
  });
});

describe("Source scan (comments stripped first)", () => {
  it("the route no longer references a Zoho client", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve(process.cwd(), "app/api/admin/orders/[id]/re-sync-invoice/route.ts"),
      "utf8"
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).not.toMatch(/zohobooks|ZohoBooksService/i);
  });
});
