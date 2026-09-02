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
 *  - **F13 trust-DB-cart override**: when existingOrder.domains is
 *    non-empty, the trusted DB rows REPLACE the client-supplied cartItems
 *    (defense vs client-tampered cart on a re-fired verify)
 *  - **Fast-path skip covers BOTH engines**: an order with EITHER
 *    `zohoInvoiceId` OR `invoiceProvider` already set skips invoice
 *    recovery entirely — checking `zohoInvoiceId` alone would have this
 *    recovery path attempt (and duplicate) a primary-issued invoice, which
 *    has no `zohoInvoiceId` at all.
 *  - Recovery branch delegates to `createPrimaryInvoice` (the same
 *    chokepoint `/api/payments/verify` uses) with
 *    `claimOptions:{staleClaimAfterMs:5*60*1000}` — allows a 5-minute-old
 *    stalled claim to be re-stolen by this recovery attempt. The
 *    chokepoint's own decision logic (flag check, fallback-to-Zoho, claim
 *    atomicity) is covered by createPrimaryInvoice.test.ts; this suite only
 *    pins that idempotency.ts calls it correctly and tolerates its failure.
 *  - createPrimaryInvoice throw → swallowed by the outer try/catch (Zoho/
 *    primary failure NEVER blocks the already-processed response)
 *  - TRIAL/ZERO-AMOUNT GUARD (idempotency.ts's OWN early return, before the
 *    recovery branch is even entered) → NO createPrimaryInvoice call
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
vi.mock("@/lib/services/orders", () => ({
  getOrderByRazorpayPaymentId,
}));

// createPrimaryInvoice is the chokepoint idempotency.ts now delegates
// invoice recovery to (Phase 1c-2) — its own claim/retry/fallback logic is
// covered by createPrimaryInvoice.test.ts.
const createPrimaryInvoice = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/billing/createPrimaryInvoice", () => ({
  createPrimaryInvoice,
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
  createPrimaryInvoice.mockReset().mockResolvedValue({
    invoiceId: "INV",
    invoiceNumber: "INV-NUM",
  });
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
    expect(createPrimaryInvoice).not.toHaveBeenCalled();
  });
});

describe("handleAlreadyProcessedPayment — happy idempotent response", () => {
  it("existingOrder with zohoInvoiceId already set → fast-path: NO createPrimaryInvoice call", async () => {
    const order = {
      _id: "ORD_DOC",
      orderId: "ORD_42",
      invoiceNumber: "INV-1",
      zohoInvoiceId: "ZOHO_INV_1",
      domains: [
        { domainName: "x.com", status: "registered", orderId: "rc_1" },
      ],
      successfulDomains: ["x.com"],
    };
    const result = await handleAlreadyProcessedPayment(
      makeCtx({ existingOrder: order })
    );
    expect(result).toBeInstanceOf(Response);
    expect(createPrimaryInvoice).not.toHaveBeenCalled();
    const body = await (result as Response).json();
    expect(body.success).toBe(true);
    expect(body.orderId).toBe("ORD_42");
    expect(body.invoiceNumber).toBe("INV-1");
    expect(body.successfulDomains).toEqual(["x.com"]);
  });

  it("existingOrder with invoiceProvider:'primary' already set (no zohoInvoiceId) → also fast-path skips", async () => {
    const order = {
      _id: "ORD_DOC",
      orderId: "ORD_42",
      invoiceNumber: "TI/2026-27/00001",
      invoiceProvider: "primary",
      zohoInvoiceId: undefined,
      domains: [
        { domainName: "x.com", status: "registered", orderId: "rc_1" },
      ],
      successfulDomains: ["x.com"],
    };
    const result = await handleAlreadyProcessedPayment(
      makeCtx({ existingOrder: order })
    );
    expect(createPrimaryInvoice).not.toHaveBeenCalled();
    const body = await (result as Response).json();
    expect(body.invoiceNumber).toBe("TI/2026-27/00001");
  });

  it("response includes registrationResults projected from order.domains", async () => {
    const order = {
      _id: "ORD_DOC",
      orderId: "ORD_42",
      invoiceNumber: "INV-1",
      zohoInvoiceId: "ZOHO_INV_1",
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

  it("F13 — trusted DB cart REPLACES client-supplied cartItems for the invoice-recovery branch", async () => {
    const order = {
      _id: "ORD_DOC",
      orderId: "ORD_42",
      invoiceNumber: "INV-1",
      amount: 50000, // paid order → invoiceable (guard passes)
      orderType: "domain",
      zohoInvoiceId: null, // forces recovery branch
      domains: [
        { itemType: "domain", domainName: "trusted.com", status: "registered" },
      ],
      successfulDomains: ["trusted.com"],
    };
    await handleAlreadyProcessedPayment(
      makeCtx({
        existingOrder: order,
        // Client tries to inject a different cart — should be ignored.
        cartItems: [{ itemType: "domain", domainName: "evil.com" }],
      })
    );
    expect(createPrimaryInvoice).toHaveBeenCalledTimes(1);
    const ctx = createPrimaryInvoice.mock.calls[0][0];
    // cartItems pass through a periodUnit-defaulting .map() before reaching
    // createPrimaryInvoice — domain items default to "years".
    expect(ctx.cartItems).toEqual([
      { itemType: "domain", domainName: "trusted.com", status: "registered", periodUnit: "years" },
    ]);
  });
});

describe("handleAlreadyProcessedPayment — invoice recovery branch", () => {
  const ORDER_NO_INVOICE = {
    _id: "ORD_DOC",
    orderId: "ORD_42",
    invoiceNumber: "INV-1",
    amount: 50000, // paid order → invoiceable (guard passes)
    orderType: "domain",
    zohoInvoiceId: null,
    domains: [
      { itemType: "domain", domainName: "x.com", status: "registered" },
    ],
    successfulDomains: ["x.com"],
  };

  it("TRIAL/ZERO-AMOUNT GUARD: orderType='hosting_trial' → NO createPrimaryInvoice call", async () => {
    const trialOrder = {
      _id: "ORD_DOC",
      orderId: "ORD_TRIAL",
      invoiceNumber: undefined,
      amount: 2, // ₹2 mandate-validation charge (refunded) — still a trial
      orderType: "hosting_trial",
      zohoInvoiceId: null,
      domains: [
        { itemType: "hosting", domainName: "trial.com", status: "pending" },
      ],
      successfulDomains: [],
    };
    const result = await handleAlreadyProcessedPayment(
      makeCtx({ existingOrder: trialOrder })
    );
    expect(createPrimaryInvoice).not.toHaveBeenCalled();
    const body = await (result as Response).json();
    expect(body.success).toBe(true);
    expect(body.orderId).toBe("ORD_TRIAL");
  });

  it("ZERO-AMOUNT GUARD: amount<=0 order → NO createPrimaryInvoice call", async () => {
    const zeroOrder = {
      _id: "ORD_DOC",
      orderId: "ORD_ZERO",
      amount: 0,
      orderType: "hosting",
      zohoInvoiceId: null,
      domains: [{ itemType: "hosting", domainName: "z.com", status: "registered" }],
      successfulDomains: ["z.com"],
    };
    await handleAlreadyProcessedPayment(makeCtx({ existingOrder: zeroOrder }));
    expect(createPrimaryInvoice).not.toHaveBeenCalled();
  });

  it("calls createPrimaryInvoice with the order context + staleClaimAfterMs claim option", async () => {
    await handleAlreadyProcessedPayment(
      makeCtx({ existingOrder: ORDER_NO_INVOICE })
    );
    expect(createPrimaryInvoice).toHaveBeenCalledTimes(1);
    const [ctx, options] = createPrimaryInvoice.mock.calls[0];
    expect(ctx.order).toBe(ORDER_NO_INVOICE);
    expect(ctx.orderId).toBe("ORD_42");
    expect(ctx.razorpay_payment_id).toBe("pay_xyz");
    expect(options).toEqual({ claimOptions: { staleClaimAfterMs: 5 * 60 * 1000 } });
  });

  it("createPrimaryInvoice throw → swallowed by outer catch (response still 200)", async () => {
    createPrimaryInvoice.mockRejectedValueOnce(new Error("both engines down"));
    const result = await handleAlreadyProcessedPayment(
      makeCtx({ existingOrder: ORDER_NO_INVOICE })
    );
    expect(result).toBeInstanceOf(Response);
    const body = await (result as Response).json();
    expect(body.success).toBe(true);
  });

  it("hosting cart item: enriches name via getPlanByPlanId (best-effort, swallow plan errors) BEFORE calling createPrimaryInvoice", async () => {
    getPlanByPlanId.mockResolvedValueOnce({ name: "Pretty Plan Name" });
    const hostingOrder = {
      ...ORDER_NO_INVOICE,
      domains: [
        {
          itemType: "hosting",
          domainName: "hosting-1",
          hostingPlan: { planId: "starter", name: "" },
        },
      ],
    };
    await handleAlreadyProcessedPayment(
      makeCtx({ existingOrder: hostingOrder })
    );
    expect(getPlanByPlanId).toHaveBeenCalledWith("starter");
    const { cartItems } = createPrimaryInvoice.mock.calls[0][0];
    expect(cartItems[0].hostingPlan.name).toBe("Pretty Plan Name");
  });
});
