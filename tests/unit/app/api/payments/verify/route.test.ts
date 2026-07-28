/**
 * Tests for `app/api/payments/verify/route.ts` (rescan-4 slice 7fx).
 * THE payment-verification entry point. Orchestrates signature
 * verification → ownership check → amount-match → renewal/upgrade/
 * idempotency forks → restricted-domain reject → pending-order claim
 * → Zoho invoice → post-payment tasks. Pins:
 *  - **Auth gate**: AuthService.getUserFromRequest returns null → 401
 *    'Unauthorized' (FIRST check — no other side effects)
 *  - **Schema validation 'order_id OR subscription_id required'**
 *    refine — both missing → validation error
 *  - **Schema validation 'cartItems required'** — missing/empty →
 *    validation error
 *  - **verifyRazorpayPayment failure passes its response straight
 *    through** (signature verification is the security gate — its
 *    NextResponse propagates verbatim, no wrapping)
 *  - **Ownership defense-in-depth**: existingOrder.userId !== user._id
 *    → 404 'Order not found' (NOT 403 — info-leak guard; the Razorpay
 *    signature is order-bound so cross-account isn't directly
 *    exploitable today but this is anti-future-regression armor)
 *  - **Already-completed early-exit**: status 'completed' → success
 *    response with 'Order already completed.' message (idempotent —
 *    re-clicks of /verify don't double-charge)
 *  - **paid / processing early-exit**: 'Payment processed, provisioning
 *    in progress.' + domainRegistrationStatus:'processing'
 *  - **Amount-match check fires on pending orders** (anti-underpayment
 *    fraud — caller could craft a smaller Razorpay order that signs
 *    the same payment)
 *  - **Renewal short-circuit**: handleRenewalPayment non-null →
 *    returned directly (skips invoice + provisioning)
 *  - **hosting_upgrade orderType** → handleUpgradePayment delegation
 *    (dynamic import path)
 *  - **Idempotency guard runs BEFORE restricted-domain check**
 *  - **Restricted-domain rejection passes its response through**
 *  - **claimPendingOrderForProcessing claim failure → 'processing'
 *    response** (webhook already claimed — anti-double-provision)
 *  - **finalizePendingOrder vs createCompletedOrder fork**: pending
 *    order → finalize (DB-trusted cart from order.domains); no
 *    pending → createCompleted (legacy path)
 *  - **cartItemsFromOrderDomains used for Zoho** — NOT request-body
 *    cartItems (the H1 fix for swap-domain-for-Zoho-line-items)
 *  - **Zoho failure SWALLOWED** → invoiceCreationFailed:true, status
 *    207 multi-status, error message in body
 *  - **forceMarkZohoCreationFailed called on Zoho throw** (durable
 *    DB record of the failure so retry layer picks it up)
 *  - **handleVerificationError catch path**: passes outer-scope refs
 *    (razorpay_order_id + payment_id + existingOrderRef) so it
 *    updates the right pending Order instead of creating a duplicate
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoisted mocks ────────────────────────────────────────────────────
const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const claimPendingOrderForProcessing = vi.hoisted(() => vi.fn());
const forceMarkZohoCreationFailed = vi.hoisted(() => vi.fn());
const getOrderByRazorpayOrderId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  claimPendingOrderForProcessing,
  forceMarkZohoCreationFailed,
  getOrderByRazorpayOrderId,
}));

const handleRenewalPayment = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/payment/renewal", () => ({ handleRenewalPayment }));

const handleAlreadyProcessedPayment = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/payment/idempotency", () => ({
  handleAlreadyProcessedPayment,
}));

const createZohoInvoice = vi.hoisted(() => vi.fn());
const runPostPaymentTasks = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/payment/post-tasks", () => ({
  createZohoInvoice,
  runPostPaymentTasks,
}));

const verifyRazorpayPayment = vi.hoisted(() => vi.fn());
const validateOrderAmountMatchesRazorpay = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/payment/verification", () => ({
  verifyRazorpayPayment,
  validateOrderAmountMatchesRazorpay,
}));

const validateNoRestrictedDomains = vi.hoisted(() => vi.fn());
const createCompletedOrder = vi.hoisted(() => vi.fn());
const finalizePendingOrder = vi.hoisted(() => vi.fn());
const cartItemsFromOrderDomains = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/payment/order-creator", () => ({
  validateNoRestrictedDomains,
  createCompletedOrder,
  finalizePendingOrder,
  cartItemsFromOrderDomains,
}));

const handleVerificationError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/payment/verification-error", () => ({
  handleVerificationError,
}));

const recordSystemLog = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/system-logs", () => ({ recordSystemLog }));

const handleUpgradePayment = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/payment/upgrade", () => ({ handleUpgradePayment }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/request-context", () => ({
  withRequestLogContext: (fn: any) => fn,
}));

// Re-pin real NextResponse
vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/payments/verify/route";

// ── helpers ──────────────────────────────────────────────────────────
function makeReq(body: unknown) {
  return new NextRequest("https://example.com/api/payments/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validBody = {
  razorpay_order_id: "order_RP1",
  razorpay_payment_id: "pay_RP1",
  razorpay_signature: "sig_RP1",
  cartItems: [{ domainName: "ex.com", price: 999, itemType: "domain" }],
};

const validUser = {
  _id: "U1",
  email: "u@x.com",
};

const validPaymentDetails = {
  status: "captured",
  amount: 99900, // paise
  currency: "INR",
  order_id: "order_RP1",
};

beforeEach(() => {
  getUserFromRequest.mockReset();
  claimPendingOrderForProcessing.mockReset();
  forceMarkZohoCreationFailed.mockReset();
  getOrderByRazorpayOrderId.mockReset();
  handleRenewalPayment.mockReset().mockResolvedValue(null);
  handleAlreadyProcessedPayment.mockReset().mockResolvedValue(null);
  createZohoInvoice.mockReset().mockResolvedValue({ invoiceNumber: "INV-1" });
  runPostPaymentTasks.mockReset().mockResolvedValue(undefined);
  verifyRazorpayPayment
    .mockReset()
    .mockResolvedValue({ ok: true, paymentDetails: validPaymentDetails });
  validateOrderAmountMatchesRazorpay
    .mockReset()
    .mockResolvedValue({ ok: true });
  validateNoRestrictedDomains.mockReset().mockReturnValue({ ok: true });
  createCompletedOrder.mockReset();
  finalizePendingOrder.mockReset();
  cartItemsFromOrderDomains.mockReset().mockReturnValue([]);
  handleVerificationError.mockReset();
  recordSystemLog.mockReset().mockResolvedValue(undefined);
  handleUpgradePayment.mockReset();
});

function setupCompletedOrderHappyPath() {
  createCompletedOrder.mockResolvedValue({
    order: {
      _id: "OID-1",
      orderId: "ORD-1",
      invoiceNumber: "INV-LOCAL-1",
      domains: [{ domainName: "ex.com" }],
    },
    orderId: "ORD-1",
    registrationResults: [],
    finalSuccessfulDomains: ["ex.com"],
    pendingDomains: [],
    failedDomains: [],
    orderDomains: [{ domainName: "ex.com" }],
    orderStatus: "completed",
  });
}

// ─── Auth gate ──────────────────────────────────────────────────────
describe("Auth gate — FIRST check", () => {
  it("no user → 401 'Unauthorized' (NO downstream side effects)", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
    expect(verifyRazorpayPayment).not.toHaveBeenCalled();
    expect(getOrderByRazorpayOrderId).not.toHaveBeenCalled();
  });
});

// ─── Schema validation ─────────────────────────────────────────────
describe("Schema validation", () => {
  it("missing both order_id AND subscription_id → validation rejected", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    const res = await POST(
      makeReq({
        razorpay_payment_id: "pay_1",
        razorpay_signature: "sig_1",
        cartItems: [{ domainName: "ex.com", price: 999 }],
      })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(verifyRazorpayPayment).not.toHaveBeenCalled();
  });

  it("missing payment_id → validation rejected", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    const res = await POST(
      makeReq({
        razorpay_order_id: "order_1",
        razorpay_signature: "sig_1",
        cartItems: [{ domainName: "ex.com", price: 999 }],
      })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("missing cartItems → ACCEPTED (cartItems is now optional; pending path derives items from the order, tokens trial from the webhook)", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce({ orderId: "ORD_C", userId: "U1", status: "completed" });
    const res = await POST(
      makeReq({
        razorpay_order_id: "order_1",
        razorpay_payment_id: "pay_1",
        razorpay_signature: "sig_1",
      })
    );
    expect(res.status).toBe(200);
  });

  it("empty cartItems array → ACCEPTED (optional)", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce({ orderId: "ORD_C", userId: "U1", status: "completed" });
    const res = await POST(makeReq({ ...validBody, cartItems: [] }));
    expect(res.status).toBe(200);
  });
});

// ─── verifyRazorpayPayment ─────────────────────────────────────────
describe("verifyRazorpayPayment — signature gate", () => {
  it("failure: passes its response straight through (NO wrapping)", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    const stubResponse = NextResponse.json(
      { error: "Invalid signature" },
      { status: 400 }
    );
    verifyRazorpayPayment.mockResolvedValueOnce({
      ok: false,
      response: stubResponse,
    });

    const res = await POST(makeReq(validBody));
    expect(res).toBe(stubResponse); // identity — response passes through
    // NOTE: getOrderByRazorpayOrderId is now called BEFORE verifyRazorpayPayment
    // (single up-front lookup, reused for the tokens-trial short-circuit), so it
    // is expected to have run once here — the point of this test is that a
    // verifyRazorpayPayment failure response is returned verbatim for non-trial
    // orders.
  });

  it("success: continues to existing-order lookup", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setupCompletedOrderHappyPath();

    await POST(makeReq(validBody));
    expect(getOrderByRazorpayOrderId).toHaveBeenCalledWith("order_RP1");
  });
});

// ─── Ownership defense-in-depth ────────────────────────────────────
describe("Ownership check — 404 'Order not found' on cross-account claim", () => {
  it("existingOrder.userId !== user._id → 404 'Order not found' (NOT 403 — info-leak guard)", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce({
      userId: "OTHER_USER",
      orderId: "ORD-foreign",
    });

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Order not found");
  });

  it("same userId → passes (proceeds to existingOrder.status check)", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce({
      userId: "U1",
      status: "completed",
      orderId: "ORD-1",
    });

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
  });
});

// ─── Already-completed early-exit ──────────────────────────────────
describe("Already-completed early-exit — idempotency", () => {
  it("status 'completed' → success message; NO claim, NO Zoho", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce({
      userId: "U1",
      status: "completed",
      orderId: "ORD-1",
    });

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toBe("Order already completed.");
    expect(body.orderId).toBe("ORD-1");
    expect(claimPendingOrderForProcessing).not.toHaveBeenCalled();
    expect(createZohoInvoice).not.toHaveBeenCalled();
  });
});

describe("paid / processing early-exit", () => {
  it.each(["paid", "processing"])(
    "status '%s' → 'provisioning in progress' message + domainRegistrationStatus:'processing'",
    async (status) => {
      getUserFromRequest.mockResolvedValueOnce(validUser);
      getOrderByRazorpayOrderId.mockResolvedValueOnce({
        userId: "U1",
        status,
        orderId: "ORD-1",
      });

      const res = await POST(makeReq(validBody));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.message).toMatch(/provisioning in progress/);
      expect(body.domainRegistrationStatus).toBe("processing");
    }
  );
});

// ─── Amount-match (anti-underpayment) ──────────────────────────────
describe("Amount-match check — anti-underpayment fraud", () => {
  it("fires on pending orders with razorpay_order_id", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce({
      userId: "U1",
      status: "pending",
      orderId: "ORD-1",
    });
    validateOrderAmountMatchesRazorpay.mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: "amount mismatch" }, { status: 400 }),
    });

    const res = await POST(makeReq(validBody));
    expect(validateOrderAmountMatchesRazorpay).toHaveBeenCalled();
    expect(res.status).toBe(400);
  });

  it("does NOT fire when no existing order (no pending row to verify against)", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setupCompletedOrderHappyPath();

    await POST(makeReq(validBody));
    expect(validateOrderAmountMatchesRazorpay).not.toHaveBeenCalled();
  });
});

// ─── Renewal short-circuit ─────────────────────────────────────────
describe("Renewal flow short-circuit", () => {
  it("handleRenewalPayment non-null → returned directly (skips invoice + provisioning)", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    const renewalResp = NextResponse.json(
      { success: true, type: "renewal" },
      { status: 200 }
    );
    handleRenewalPayment.mockResolvedValueOnce(renewalResp);

    const res = await POST(makeReq(validBody));
    expect(res).toBe(renewalResp);
    expect(createZohoInvoice).not.toHaveBeenCalled();
    expect(handleAlreadyProcessedPayment).not.toHaveBeenCalled();
  });
});

// ─── hosting_upgrade orderType ─────────────────────────────────────
describe("hosting_upgrade orderType — handleUpgradePayment delegation", () => {
  it("existingOrder.orderType === 'hosting_upgrade' → handleUpgradePayment called", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce({
      userId: "U1",
      orderType: "hosting_upgrade",
      status: "pending_upgrade",
      orderId: "ORD-1",
    });
    const upgradeResp = NextResponse.json(
      { success: true, type: "upgrade" },
      { status: 200 }
    );
    handleUpgradePayment.mockResolvedValueOnce(upgradeResp);

    const res = await POST(makeReq(validBody));
    expect(handleUpgradePayment).toHaveBeenCalledWith(
      "order_RP1",
      "pay_RP1",
      "sig_RP1"
    );
    expect(res).toBe(upgradeResp);
  });
});

// ─── Idempotency guard ─────────────────────────────────────────────
describe("Idempotency guard — runs BEFORE restricted-domain check", () => {
  it("handleAlreadyProcessedPayment non-null response → returned directly", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    const idempResp = NextResponse.json(
      { success: true, idempotent: true },
      { status: 200 }
    );
    handleAlreadyProcessedPayment.mockResolvedValueOnce(idempResp);

    const res = await POST(makeReq(validBody));
    expect(res).toBe(idempResp);
    expect(validateNoRestrictedDomains).not.toHaveBeenCalled();
  });
});

// ─── Restricted-domain rejection ───────────────────────────────────
describe("Restricted-domain rejection — runs after idempotency", () => {
  it("validateNoRestrictedDomains failure → response passes through", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    const restrictedResp = NextResponse.json(
      { error: "restricted TLD" },
      { status: 400 }
    );
    validateNoRestrictedDomains.mockReturnValueOnce({
      ok: false,
      response: restrictedResp,
    });

    const res = await POST(makeReq(validBody));
    expect(res).toBe(restrictedResp);
    expect(claimPendingOrderForProcessing).not.toHaveBeenCalled();
  });
});

// ─── Pending-order claim ──────────────────────────────────────────
describe("Pending-order claim — webhook-race guard", () => {
  it("claim failure (webhook beat us) → 'processing' response with orderId", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce({
      userId: "U1",
      status: "pending",
      orderId: "ORD-1",
    });
    claimPendingOrderForProcessing.mockResolvedValueOnce(null);

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toMatch(/provisioning in progress/);
    expect(body.domainRegistrationStatus).toBe("processing");
    expect(body.orderId).toBe("ORD-1");
    expect(finalizePendingOrder).not.toHaveBeenCalled();
  });

  it("claim success → finalizePendingOrder called (NOT createCompletedOrder)", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce({
      userId: "U1",
      status: "pending",
      orderId: "ORD-1",
    });
    claimPendingOrderForProcessing.mockResolvedValueOnce({
      _id: "OID-1",
      orderId: "ORD-1",
      domains: [{ domainName: "ex.com" }],
    });
    finalizePendingOrder.mockResolvedValueOnce({
      order: {
        _id: "OID-1",
        orderId: "ORD-1",
        invoiceNumber: "INV-1",
        domains: [{ domainName: "ex.com" }],
      },
      orderId: "ORD-1",
      registrationResults: [],
      finalSuccessfulDomains: ["ex.com"],
      pendingDomains: [],
      failedDomains: [],
      orderDomains: [{ domainName: "ex.com" }],
      orderStatus: "completed",
    });

    await POST(makeReq(validBody));
    expect(finalizePendingOrder).toHaveBeenCalled();
    expect(createCompletedOrder).not.toHaveBeenCalled();
  });

  it("**finalizePendingOrder is NOT passed cartItems** (anti-swap-domain — DB-trusted only)", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce({
      userId: "U1",
      status: "pending",
      orderId: "ORD-1",
    });
    claimPendingOrderForProcessing.mockResolvedValueOnce({
      _id: "OID-1",
      orderId: "ORD-1",
      domains: [{ domainName: "ex.com" }],
    });
    finalizePendingOrder.mockResolvedValueOnce({
      order: { _id: "OID-1", orderId: "ORD-1", domains: [] },
      orderId: "ORD-1",
      registrationResults: [],
      finalSuccessfulDomains: [],
      pendingDomains: [],
      failedDomains: [],
      orderDomains: [],
      orderStatus: "completed",
    });

    await POST(makeReq(validBody));

    // The first arg to finalizePendingOrder must NOT carry user-supplied cartItems
    const finalizeArgs = finalizePendingOrder.mock.calls[0][0];
    expect(finalizeArgs).not.toHaveProperty("cartItems");
  });
});

describe("createCompletedOrder — legacy / no-pending fallback", () => {
  it("no existing pending order → createCompletedOrder called", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setupCompletedOrderHappyPath();

    await POST(makeReq(validBody));
    expect(createCompletedOrder).toHaveBeenCalled();
    expect(finalizePendingOrder).not.toHaveBeenCalled();
  });
});

// ─── Zoho invoice + cartItemsFromOrderDomains ──────────────────────
describe("Zoho invoice — DB-trusted line items (H1 fix)", () => {
  it("cartItemsFromOrderDomains called with order.domains (NOT request-body cartItems)", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    const dbDomains = [{ domainName: "real.com", price: 500 }];
    createCompletedOrder.mockResolvedValueOnce({
      order: {
        _id: "OID-1",
        orderId: "ORD-1",
        domains: dbDomains,
        invoiceNumber: "INV-1",
      },
      orderId: "ORD-1",
      registrationResults: [],
      finalSuccessfulDomains: ["real.com"],
      pendingDomains: [],
      failedDomains: [],
      orderDomains: dbDomains,
      orderStatus: "completed",
    });
    cartItemsFromOrderDomains.mockReturnValueOnce([
      { domainName: "real.com", price: 500 },
    ]);

    await POST(makeReq(validBody));
    expect(cartItemsFromOrderDomains).toHaveBeenCalledWith(dbDomains);
  });

  it("Zoho failure SWALLOWED → invoiceCreationFailed:true, status 207", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setupCompletedOrderHappyPath();
    createZohoInvoice.mockRejectedValueOnce(new Error("Zoho down"));
    forceMarkZohoCreationFailed.mockResolvedValueOnce(undefined);

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.invoiceStatus).toBe("failed");
    expect(body.invoiceCreationError).toMatch(/contact support/i);
  });

  it("**forceMarkZohoCreationFailed called on Zoho throw** (durable DB record)", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setupCompletedOrderHappyPath();
    createZohoInvoice.mockRejectedValueOnce(new Error("Zoho down"));
    forceMarkZohoCreationFailed.mockResolvedValueOnce(undefined);

    await POST(makeReq(validBody));
    expect(forceMarkZohoCreationFailed).toHaveBeenCalledWith("OID-1");
  });

  it("Zoho throw → recordSystemLog called with durable failure record", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setupCompletedOrderHappyPath();
    createZohoInvoice.mockRejectedValueOnce(new Error("Zoho down"));
    forceMarkZohoCreationFailed.mockResolvedValueOnce(undefined);

    await POST(makeReq(validBody));
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "error",
        source: "payments/verify",
        service: "payments",
      })
    );
  });

  it("Zoho returns no invoiceNumber → falls back to local order.invoiceNumber", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setupCompletedOrderHappyPath();
    createZohoInvoice.mockResolvedValueOnce({ invoiceNumber: null });

    const res = await POST(makeReq(validBody));
    const body = await res.json();
    expect(body.invoiceNumber).toBe("INV-LOCAL-1"); // local fallback
  });

  it("Zoho success: finalInvoiceNumber set from Zoho return", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setupCompletedOrderHappyPath();
    createZohoInvoice.mockResolvedValueOnce({ invoiceNumber: "ZOHO-999" });

    const res = await POST(makeReq(validBody));
    const body = await res.json();
    expect(body.invoiceNumber).toBe("ZOHO-999");
    expect(body.invoiceStatus).toBe("created");
    expect(res.status).toBe(200); // 200 — not 207
  });
});

// ─── Status code: 207 vs 200 ───────────────────────────────────────
describe("Status code", () => {
  it("Zoho success → 200", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setupCompletedOrderHappyPath();
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
  });

  it("Zoho failure → 207 (multi-status — payment succeeded, invoice didn't)", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setupCompletedOrderHappyPath();
    createZohoInvoice.mockRejectedValueOnce(new Error("Zoho down"));
    forceMarkZohoCreationFailed.mockResolvedValueOnce(undefined);
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(207);
  });
});

// ─── Response message branching ────────────────────────────────────
describe("Response message — hosting vs domain composition", () => {
  function setOrderWith(opts: {
    successfulDomains: string[];
    pendingDomains?: string[];
    failedDomains?: any[];
  }) {
    createCompletedOrder.mockResolvedValueOnce({
      order: {
        _id: "OID-1",
        orderId: "ORD-1",
        invoiceNumber: "INV-1",
        domains: [{ domainName: "ex.com" }],
      },
      orderId: "ORD-1",
      registrationResults: [],
      finalSuccessfulDomains: opts.successfulDomains,
      pendingDomains:
        opts.pendingDomains?.map((d) => ({ domainName: d })) ?? [],
      failedDomains:
        opts.failedDomains ??
        ([] as Array<{ domainName: string; error: string }>),
      orderDomains: [{ domainName: "ex.com" }],
      orderStatus: "completed",
    });
  }

  it("hosting+domain mix successful → 'services registered and provisioned'", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setOrderWith({ successfulDomains: ["ex.com"] });

    const res = await POST(
      makeReq({
        ...validBody,
        cartItems: [
          { domainName: "ex.com", price: 999, itemType: "domain" },
          { domainName: "h.ex.com", price: 1500, itemType: "hosting" },
        ],
      })
    );
    const body = await res.json();
    expect(body.message).toMatch(/services registered and provisioned/);
  });

  it("hosting-only success → 'hosting provisioned successfully'", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setOrderWith({ successfulDomains: ["h.ex.com"] });

    const res = await POST(
      makeReq({
        ...validBody,
        cartItems: [
          { domainName: "h.ex.com", price: 1500, itemType: "hosting" },
        ],
      })
    );
    const body = await res.json();
    expect(body.message).toMatch(/hosting provisioned successfully/);
  });

  it("domain-only success → 'domains registered successfully'", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setOrderWith({ successfulDomains: ["ex.com"] });

    const res = await POST(makeReq(validBody));
    const body = await res.json();
    expect(body.message).toMatch(/domains registered successfully/);
  });

  it("no success but pending → 'being processed' message", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setOrderWith({ successfulDomains: [], pendingDomains: ["ex.com"] });

    const res = await POST(makeReq(validBody));
    const body = await res.json();
    expect(body.message).toMatch(/being processed/);
  });

  it("domainRegistrationStatus: all successful → 'completed'", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setOrderWith({ successfulDomains: ["ex.com"] });

    const res = await POST(makeReq(validBody));
    const body = await res.json();
    expect(body.domainRegistrationStatus).toBe("completed");
  });

  it("domainRegistrationStatus: some pending → 'pending'", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setOrderWith({ successfulDomains: [], pendingDomains: ["ex.com"] });

    const res = await POST(makeReq(validBody));
    const body = await res.json();
    expect(body.domainRegistrationStatus).toBe("pending");
  });

  it("failedDomains projection: {domainName, error} pair", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setOrderWith({
      successfulDomains: [],
      failedDomains: [{ domainName: "ex.com", error: "boom" }],
    });

    const res = await POST(makeReq(validBody));
    const body = await res.json();
    expect(body.failedDomains).toEqual([
      { domainName: "ex.com", error: "boom" },
    ]);
  });
});

// ─── Post-payment tasks ────────────────────────────────────────────
describe("runPostPaymentTasks — non-critical tasks", () => {
  it("called after Zoho (even on Zoho failure, post-tasks still run — email/notifications)", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setupCompletedOrderHappyPath();
    createZohoInvoice.mockRejectedValueOnce(new Error("Zoho down"));
    forceMarkZohoCreationFailed.mockResolvedValueOnce(undefined);

    await POST(makeReq(validBody));
    expect(runPostPaymentTasks).toHaveBeenCalled();
  });
});

// ─── handleVerificationError catch path ────────────────────────────
describe("handleVerificationError — catch path passes outer refs", () => {
  it("throw → delegates to handleVerificationError with razorpay_order_id + payment_id + existingOrder", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    createCompletedOrder.mockRejectedValueOnce(new Error("DB outage"));
    const fallbackResp = NextResponse.json(
      { error: "fallback handled" },
      { status: 500 }
    );
    handleVerificationError.mockResolvedValueOnce(fallbackResp);

    const res = await POST(makeReq(validBody));
    expect(res).toBe(fallbackResp);
    const args = handleVerificationError.mock.calls[0][0];
    expect(args.razorpay_order_id).toBe("order_RP1");
    expect(args.razorpay_payment_id).toBe("pay_RP1");
    expect(args.existingOrder).toBeNull(); // we mocked null
    expect(args.user).toBe(validUser);
  });

  it("**throw early (before validation) → user is null in catch args**", async () => {
    // AuthService throws BEFORE user is assigned — catch fires with user=null
    getUserFromRequest.mockRejectedValueOnce(new Error("auth blew up"));
    const fallbackResp = NextResponse.json(
      { error: "fallback" },
      { status: 500 }
    );
    handleVerificationError.mockResolvedValueOnce(fallbackResp);

    await POST(makeReq(validBody));
    const args = handleVerificationError.mock.calls[0][0];
    expect(args.user).toBeNull();
  });
});

describe("POST /api/payments/verify — Tokens-flow trial mandate", () => {
  it("hosting_trial + tokens order → success 'provisioning', NO finalize/create (webhook owns it)", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce({
      _id: "OID-T",
      orderId: "ord_trial",
      userId: "U1",
      orderType: "hosting_trial",
      mandateMode: "tokens",
      status: "pending",
    });
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.orderId).toBe("ord_trial");
    expect(body.domainRegistrationStatus).toBe("processing");
    expect(finalizePendingOrder).not.toHaveBeenCalled();
    expect(createCompletedOrder).not.toHaveBeenCalled();
  });

  it("tokens-trial verifies WITHOUT a client signature (mandate flow) → still 200", async () => {
    getUserFromRequest.mockResolvedValueOnce(validUser);
    getOrderByRazorpayOrderId.mockResolvedValueOnce({
      _id: "OID-T",
      orderId: "ord_trial",
      userId: "U1",
      orderType: "hosting_trial",
      mandateMode: "tokens",
      status: "completed",
    });
    // No razorpay_signature in the body — schema now allows it (optional).
    const res = await POST(
      makeReq({
        razorpay_order_id: "order_RP1",
        razorpay_payment_id: "pay_RP1",
        cartItems: [{ domainName: "trial.com", price: 0, itemType: "hosting" }],
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});
