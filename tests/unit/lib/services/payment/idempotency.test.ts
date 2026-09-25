/**
 * Tests for `@/lib/services/payment/idempotency` (rescan-4 slice 7ej;
 * updated for Primary Billing Integration Phase 1c-2).
 * handleAlreadyProcessedPayment — payment-verify idempotency guard.
 * Pins:
 *  - existingOrder null + lookup-by-paymentId null → returns null (new
 *    payment, caller proceeds normally)
 *  - existingOrder present (or paymentId-lookup hit) → returns a 200
 *    NextResponse with {success:true, orderId, invoiceNumber,
 *    registrationResults, successfulDomains}
 *  - **No invoice recovery** (since 25 Sep 2026: DMS issues no bills). A
 *    re-fired verify answers from the stored order and writes nothing; the
 *    first verify already flagged a paid order for billing in ResellerOS.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getPlanByPlanId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hosting-plans", () => ({ getPlanByPlanId }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const isHostingItem = vi.hoisted(() =>
  vi.fn((item: { itemType?: string }) => item.itemType === "hosting")
);
vi.mock("@/lib/billing", () => ({ isHostingItem }));

const getOrderByRazorpayPaymentId = vi.hoisted(() => vi.fn());
const markInvoiceCreationFailed = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  getOrderByRazorpayPaymentId,
  markInvoiceCreationFailed,
}));


vi.unmock("next/server");
const { NextResponse } = await vi.importActual<typeof import("next/server")>(
  "next/server"
);
// The handler uses NextResponse.json — re-stub the test setup's stub
// with the real implementation for this file only.
vi.doMock("next/server", () => ({ NextResponse }));

import { handleAlreadyProcessedPayment } from "@/lib/services/payment/idempotency";

beforeEach(() => {
  getPlanByPlanId.mockReset();
  isHostingItem.mockClear();
  getOrderByRazorpayPaymentId.mockReset();
  markInvoiceCreationFailed.mockReset().mockResolvedValue(undefined);
});

const USER = { firstName: "A", lastName: "B", email: "a@x.test" } as never;
const PAYMENT_DETAILS = { amount: 50000 } as never;

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    razorpay_order_id: "ord_rzp_42",
    razorpay_payment_id: "pay_xyz",
    paymentDetails: PAYMENT_DETAILS,
    user: USER,
    existingOrder: null,
    cartItems: [{ itemType: "domain", domainName: "x.com" }],
    ...overrides,
  } as never;
}

describe("handleAlreadyProcessedPayment — early-return null (new payment)", () => {
  it("existingOrder null AND payment-id lookup also null → returns null (caller proceeds)", async () => {
    getOrderByRazorpayPaymentId.mockResolvedValueOnce(null);
    const result = await handleAlreadyProcessedPayment(makeCtx());
    expect(result).toBeNull();
    expect(getOrderByRazorpayPaymentId).toHaveBeenCalledWith("pay_xyz");
    expect(markInvoiceCreationFailed).not.toHaveBeenCalled();
  });
});

describe("handleAlreadyProcessedPayment — happy idempotent response", () => {
  it("existingOrder with HISTORICAL invoiceProvider:'zoho' → fast-path: no flag written", async () => {
    const order = {
      _id: "ORD_DOC",
      orderId: "ORD_42",
      invoiceNumber: "INV-1",
      amount: 50000, // paid, invoiceable — only invoiceProvider stops recovery
      orderType: "domain",
      invoiceProvider: "zoho",
      domains: [
        { domainName: "x.com", status: "registered", orderId: "rc_1" },
      ],
      successfulDomains: ["x.com"],
    };
    const result = await handleAlreadyProcessedPayment(
      makeCtx({ existingOrder: order })
    );
    expect(result).toBeInstanceOf(Response);
    expect(markInvoiceCreationFailed).not.toHaveBeenCalled();
    const body = await (result as Response).json();
    expect(body.success).toBe(true);
    expect(body.orderId).toBe("ORD_42");
    expect(body.invoiceNumber).toBe("INV-1");
    expect(body.successfulDomains).toEqual(["x.com"]);
  });

  it("existingOrder with invoiceProvider:'primary' already set → also fast-path skips", async () => {
    const order = {
      _id: "ORD_DOC",
      orderId: "ORD_42",
      invoiceNumber: "TI/2026-27/00001",
      invoiceProvider: "primary",
      amount: 50000,
      orderType: "domain",
      domains: [
        { domainName: "x.com", status: "registered", orderId: "rc_1" },
      ],
      successfulDomains: ["x.com"],
    };
    const result = await handleAlreadyProcessedPayment(
      makeCtx({ existingOrder: order })
    );
    expect(markInvoiceCreationFailed).not.toHaveBeenCalled();
    const body = await (result as Response).json();
    expect(body.invoiceNumber).toBe("TI/2026-27/00001");
  });

  it("response includes registrationResults projected from order.domains", async () => {
    const order = {
      _id: "ORD_DOC",
      orderId: "ORD_42",
      invoiceNumber: "INV-1",
      invoiceProvider: "primary",
      domains: [
        { domainName: "x.com", status: "registered", orderId: "rc_1" },
        { domainName: "y.com", status: "failed", orderId: null, error: "bad TLD" },
      ],
      successfulDomains: ["x.com"],
    };
    const result = await handleAlreadyProcessedPayment(
      makeCtx({ existingOrder: order })
    );
    const body = await (result as Response).json();
    expect(body.registrationResults).toEqual([
      { domainName: "x.com", status: "registered", orderId: "rc_1" },
      { domainName: "y.com", status: "failed", orderId: null, error: "bad TLD" },
    ]);
  });
});

// DMS issues no bills (owner decision, 24 Sep 2026): the invoice-recovery
// branch that ran on a duplicate /verify was removed with the engine. The
// first /verify flagged a paid order for billing in ResellerOS already.
describe("handleAlreadyProcessedPayment — no invoice recovery", () => {
  it("a duplicate verify on an uninvoiced paid order answers 200 and writes nothing", async () => {
    const order = {
      _id: "ORD_DOC",
      orderId: "ORD_42",
      amount: 50000,
      orderType: "domain",
      status: "completed",
      domains: [{ itemType: "domain", domainName: "trusted.com", status: "registered" }],
      successfulDomains: ["trusted.com"],
    };
    const result = await handleAlreadyProcessedPayment(makeCtx({ existingOrder: order }));
    expect((result as Response).status).toBe(200);
    expect((await (result as Response).json()).success).toBe(true);
    expect(markInvoiceCreationFailed).not.toHaveBeenCalled();
  });
});
