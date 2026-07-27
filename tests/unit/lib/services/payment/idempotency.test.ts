/**
 * Tests for `@/lib/services/payment/idempotency` (rescan-4 slice 7ej).
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
 *  - Zoho-recovery branch (no existing zohoInvoiceId): runs
 *    claimOrderForZohoInvoice with **staleClaimAfterMs:5*60*1000** —
 *    allows a 5-minute-old stalled claim to be re-stolen
 *  - claimOrderForZohoInvoice null → skips Zoho call (already claimed
 *    by another worker)
 *  - createInvoice success → recordZohoInvoiceForOrder + log
 *  - createInvoice resolves with no invoice_id → releaseZohoInvoiceClaim
 *    (the orphan-claim guard)
 *  - createInvoice throw → releaseZohoInvoiceClaim + rethrow into outer
 *    try (which CATCHES — Zoho failure NEVER blocks the
 *    already-processed response)
 *  - existingOrder already has zohoInvoiceId → fast-path skip, no
 *    claim/createInvoice call
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getPlanByPlanId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hosting-plans", () => ({ getPlanByPlanId }));

const createInvoice = vi.hoisted(() => vi.fn());
vi.mock("@/lib/zohobooks", () => ({
  ZohoBooksService: { getInstance: () => ({ createInvoice }) },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const isHostingItem = vi.hoisted(() =>
  vi.fn((item: { itemType?: string }) => item.itemType === "hosting")
);
vi.mock("@/lib/billing", () => ({ isHostingItem }));

const claimOrder = vi.hoisted(() => vi.fn());
const getOrderByRazorpayPaymentId = vi.hoisted(() => vi.fn());
const recordInvoice = vi.hoisted(() => vi.fn());
const releaseClaim = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  claimOrderForZohoInvoice: claimOrder,
  getOrderByRazorpayPaymentId,
  recordZohoInvoiceForOrder: recordInvoice,
  releaseZohoInvoiceClaim: releaseClaim,
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
  createInvoice.mockReset();
  isHostingItem.mockClear();
  claimOrder.mockReset();
  getOrderByRazorpayPaymentId.mockReset();
  recordInvoice.mockReset();
  releaseClaim.mockReset();
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
    // No Zoho work fired.
    expect(claimOrder).not.toHaveBeenCalled();
  });
});

describe("handleAlreadyProcessedPayment — happy idempotent response", () => {
  it("existingOrder with zohoInvoiceId already set → fast-path: NO claim, NO createInvoice", async () => {
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
    expect(claimOrder).not.toHaveBeenCalled();
    expect(createInvoice).not.toHaveBeenCalled();
    const body = await (result as Response).json();
    expect(body.success).toBe(true);
    expect(body.orderId).toBe("ORD_42");
    expect(body.invoiceNumber).toBe("INV-1");
    expect(body.successfulDomains).toEqual(["x.com"]);
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

  it("F13 — trusted DB cart REPLACES client-supplied cartItems for the Zoho-recovery branch", async () => {
    const order = {
      _id: "ORD_DOC",
      orderId: "ORD_42",
      invoiceNumber: "INV-1",
      amount: 50000, // paid order → invoiceable (guard passes)
      orderType: "domain",
      zohoInvoiceId: null, // forces Zoho recovery branch
      domains: [
        { itemType: "domain", domainName: "trusted.com", status: "registered" },
      ],
      successfulDomains: ["trusted.com"],
    };
    claimOrder.mockResolvedValueOnce(null); // skip past invoice creation
    await handleAlreadyProcessedPayment(
      makeCtx({
        existingOrder: order,
        // Client tries to inject a different cart — should be ignored.
        cartItems: [{ itemType: "domain", domainName: "evil.com" }],
      })
    );
    // claimOrder is reached (Zoho recovery path), proving we didn't
    // short-circuit on the client cart.
    expect(claimOrder).toHaveBeenCalledWith("ORD_DOC", {
      staleClaimAfterMs: 5 * 60 * 1000,
    });
  });
});

describe("handleAlreadyProcessedPayment — Zoho recovery branch", () => {
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

  it("TRIAL/ZERO-AMOUNT GUARD: orderType='hosting_trial' → NO claim, NO createInvoice", async () => {
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
    expect(claimOrder).not.toHaveBeenCalled();
    expect(createInvoice).not.toHaveBeenCalled();
    const body = await (result as Response).json();
    expect(body.success).toBe(true);
    expect(body.orderId).toBe("ORD_TRIAL");
  });

  it("ZERO-AMOUNT GUARD: amount<=0 order → NO claim, NO createInvoice", async () => {
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
    expect(claimOrder).not.toHaveBeenCalled();
    expect(createInvoice).not.toHaveBeenCalled();
  });

  it("claim returns null → skips Zoho call (another worker already claimed)", async () => {
    claimOrder.mockResolvedValueOnce(null);
    const result = await handleAlreadyProcessedPayment(
      makeCtx({ existingOrder: ORDER_NO_INVOICE })
    );
    expect(createInvoice).not.toHaveBeenCalled();
    // Response still returned (idempotency-OK).
    const body = await (result as Response).json();
    expect(body.success).toBe(true);
  });

  it("claim succeeds → createInvoice + recordZohoInvoiceForOrder on success", async () => {
    claimOrder.mockResolvedValueOnce({ _id: "ORD_DOC" });
    createInvoice.mockResolvedValueOnce({
      invoice_id: "ZOHO_INV_NEW",
      invoice_number: "INV-NEW",
    });
    await handleAlreadyProcessedPayment(
      makeCtx({ existingOrder: ORDER_NO_INVOICE })
    );
    expect(recordInvoice).toHaveBeenCalledWith("ORD_DOC", {
      invoiceId: "ZOHO_INV_NEW",
      invoiceNumber: "INV-NEW",
    });
  });

  it("createInvoice resolves with no invoice_id → releaseClaim (orphan-claim guard)", async () => {
    claimOrder.mockResolvedValueOnce({ _id: "ORD_DOC" });
    createInvoice.mockResolvedValueOnce({ invoice_id: null });
    await handleAlreadyProcessedPayment(
      makeCtx({ existingOrder: ORDER_NO_INVOICE })
    );
    expect(releaseClaim).toHaveBeenCalledWith("ORD_DOC");
    expect(recordInvoice).not.toHaveBeenCalled();
  });

  it("createInvoice THROW → releaseClaim AND the outer catch swallows (response still 200)", async () => {
    claimOrder.mockResolvedValueOnce({ _id: "ORD_DOC" });
    createInvoice.mockRejectedValueOnce(new Error("token expired"));
    const result = await handleAlreadyProcessedPayment(
      makeCtx({ existingOrder: ORDER_NO_INVOICE })
    );
    expect(releaseClaim).toHaveBeenCalledWith("ORD_DOC");
    // Zoho failure NEVER blocks the response — caller still gets 200.
    expect(result).toBeInstanceOf(Response);
    const body = await (result as Response).json();
    expect(body.success).toBe(true);
  });

  it("hosting cart item: enriches name via getPlanByPlanId (best-effort, swallow plan errors)", async () => {
    claimOrder.mockResolvedValueOnce({ _id: "ORD_DOC" });
    createInvoice.mockResolvedValueOnce({
      invoice_id: "X",
      invoice_number: "Y",
    });
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
  });
});
