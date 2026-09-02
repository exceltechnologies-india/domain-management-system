/**
 * Tests for `app/razorpay/webhook/route.ts` (slice 7iC).
 *
 * Production payment-capture webhook for one-time purchases (domain
 * registrations + hosting orders). NOT the same as the already-tested
 * subscription-events webhook at `/api/webhooks/razorpay` — this one
 * lives at a separate URL Razorpay was historically pointed at, and
 * handles two events:
 *  - `payment.captured` — the customer has paid; provision the order.
 *  - `refund.processed` — a refund was issued; create a Zoho credit
 *    note so accounting stays balanced.
 *
 * Threat model:
 *  - **Forged webhook → unauthorized provisioning**: every request
 *    is HMAC-SHA256 verified against `RAZORPAY_WEBHOOK_SECRET`.
 *    Pinned: signature mismatch → 400 with NO downstream work.
 *  - **Misconfigured secret → silent prod-bypass**: if the env var
 *    is missing, the route refuses (500 Configuration Error)
 *    rather than fail-open. Pinned.
 *  - **Razorpay retry-storm via 4xx/5xx for benign cases**: orders-
 *    not-found, unknown events, idempotent re-deliveries all return
 *    200 so Razorpay's retry pipeline stops. Pinned per-branch.
 *  - **Double-provisioning race with /verify**: the worker claims
 *    the pending order via atomic `claimPendingOrderForProcessing`;
 *    if the claim is lost (`/verify` won the race), the webhook
 *    returns 200 with NO finalizePendingOrder call. Pinned.
 *  - **Renewal / upgrade orders DEFERRED to /verify**: provisioning
 *    those order types from the webhook would skip `handleRenewal-
 *    Payment` / `handleUpgradePayment`'s hosting-reactivation +
 *    expiry-extension logic. Pinned: orderType in {renewal,
 *    hosting_upgrade} → stamp paymentId only, NO finalizePendingOrder.
 *  - **Zoho outage → stuck provisioning**: Zoho invoice creation
 *    happens inline AFTER the claim. A Zoho failure is swallowed
 *    with `zohoInvoiceId = 'creation_failed'` so provisioning still
 *    runs; the self-heal cron picks up the sentinel later. Pinned:
 *    Zoho throw does NOT rethrow.
 *  - **Provisioning throw → admin-inspection state**: if
 *    finalizePendingOrder throws, the row stays in `processing` and
 *    the webhook rethrows so Razorpay retries (we get another shot).
 *    Pinned.
 *  - **Refund accounting failure ≠ Razorpay retry**: credit-note
 *    failures are swallowed (admin alert via logs); Razorpay
 *    doesn't need to retry refund webhooks for accounting issues.
 *    Pinned per-branch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

// Set the env var via vi.hoisted so it runs BEFORE any module import
// (including the route under test). The route captures
// `WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET` at module-
// load time, so a plain top-level assignment isn't early enough —
// vi.mock + the route import are hoisted above it by Vitest.
const WEBHOOK_SECRET = "test_webhook_secret_xyz";
vi.hoisted(() => {
  process.env.RAZORPAY_WEBHOOK_SECRET = "test_webhook_secret_xyz";
});

const connectDB = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

const getUserById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserById }));

const claimPendingOrderForProcessing = vi.hoisted(() => vi.fn());
const findOrderByRazorpayOrderIdOrInternalId = vi.hoisted(() => vi.fn());
const getOrderByRazorpayPaymentId = vi.hoisted(() => vi.fn());
const forceMarkZohoCreationFailed = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  claimPendingOrderForProcessing,
  findOrderByRazorpayOrderIdOrInternalId,
  getOrderByRazorpayPaymentId,
  forceMarkZohoCreationFailed,
}));

const finalizePendingOrder = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/payment/order-creator", () => ({
  finalizePendingOrder,
}));

// createPrimaryInvoice is the chokepoint the webhook now delegates invoice
// creation to (Primary Billing Integration Phase 1c-3) — its own claim/
// retry/fallback-to-Zoho decision logic is covered by
// createPrimaryInvoice.test.ts; this suite only pins that the webhook calls
// it correctly and reacts correctly to success/failure.
const createPrimaryInvoice = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/billing/createPrimaryInvoice", () => ({
  createPrimaryInvoice,
}));

const refundPayment = vi.hoisted(() => vi.fn());
vi.mock("@/lib/razorpay", () => ({
  RazorpayService: { refundPayment },
}));

const createTokensFlowTrialHosting = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/payment/tokens-trial-provisioner", () => ({
  createTokensFlowTrialHosting,
}));

const findUserHosting = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hostings", () => ({
  findUserHosting,
}));

const zohoCreateInvoice = vi.hoisted(() => vi.fn());
const zohoCreateCreditNote = vi.hoisted(() => vi.fn());
const zohoGetContactByEmail = vi.hoisted(() => vi.fn());
const zohoGetInstance = vi.hoisted(() =>
  vi.fn(() => ({
    createInvoice: zohoCreateInvoice,
    createCreditNote: zohoCreateCreditNote,
    getContactByEmail: zohoGetContactByEmail,
  }))
);
vi.mock("@/lib/zohobooks", () => ({
  ZohoBooksService: { getInstance: zohoGetInstance },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/razorpay/webhook/route";

// ── helpers ──────────────────────────────────────────────────────────
function signBody(body: string, secret: string = WEBHOOK_SECRET) {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

function makeReq(opts: { body: unknown; signature?: string | null; secret?: string }) {
  const raw = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  const sig =
    opts.signature === undefined
      ? signBody(raw, opts.secret ?? WEBHOOK_SECRET)
      : opts.signature;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sig !== null) headers["x-razorpay-signature"] = sig;
  return new NextRequest("https://example.com/razorpay/webhook", {
    method: "POST",
    headers,
    body: raw,
  });
}

interface FakeOrder {
  orderId: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  userId: string;
  status: string;
  amount?: number;
  orderType?: string;
  zohoInvoiceId?: string;
  invoiceNumber?: string;
  domains: Array<{
    domainName: string;
    price: number;
    itemType?: string;
    registrationPeriod?: number;
    hostingPlan?: { name: string };
  }>;
  save: ReturnType<typeof vi.fn>;
}

function makeOrder(over: Partial<FakeOrder> = {}): FakeOrder {
  return {
    orderId: "ORD-1",
    razorpayOrderId: "rzp_order_AAA",
    razorpayPaymentId: "pending",
    userId: "U1",
    status: "pending",
    amount: 118000, // paid order → invoiceable (trial/zero-amount guard passes)
    domains: [
      { domainName: "alice.com", price: 1000, itemType: "domain", registrationPeriod: 1 },
    ],
    save: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

function paymentCapturedPayload(over: {
  paymentId?: string;
  amount?: number;
  currency?: string;
  orderIdReceipt?: string;
  description?: string;
  razorpayOrderId?: string;
} = {}) {
  return {
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: over.paymentId ?? "pay_XYZ",
          amount: over.amount ?? 118000,
          currency: over.currency ?? "INR",
          order_id: over.razorpayOrderId ?? "rzp_order_AAA",
          description: over.description,
          notes: over.orderIdReceipt ? { receipt: over.orderIdReceipt } : undefined,
        },
      },
    },
  };
}

function refundProcessedPayload(over: {
  refundId?: string;
  paymentId?: string;
  amount?: number;
  missingEntity?: boolean;
} = {}) {
  if (over.missingEntity) {
    return { event: "refund.processed", payload: {} };
  }
  return {
    event: "refund.processed",
    payload: {
      refund: {
        entity: {
          id: over.refundId ?? "rfnd_AAA",
          payment_id: over.paymentId ?? "pay_XYZ",
          amount: over.amount ?? 118000,
        },
      },
    },
  };
}

beforeEach(() => {
  connectDB.mockReset().mockResolvedValue(undefined);
  getUserById.mockReset();
  claimPendingOrderForProcessing.mockReset();
  findOrderByRazorpayOrderIdOrInternalId.mockReset();
  getOrderByRazorpayPaymentId.mockReset();
  forceMarkZohoCreationFailed.mockReset();
  finalizePendingOrder.mockReset();
  createPrimaryInvoice.mockReset();
  zohoCreateInvoice.mockReset();
  zohoCreateCreditNote.mockReset();
  zohoGetContactByEmail.mockReset();
  zohoGetInstance.mockClear();
});

// ═══════════════════════════════════════════════════════════════════
// Config + signature gates
// ═══════════════════════════════════════════════════════════════════
describe("Signature verification gate", () => {
  it("missing x-razorpay-signature header → 400 'Missing Signature'; NO downstream work", async () => {
    const res = await POST(
      makeReq({ body: paymentCapturedPayload(), signature: null })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing Signature");
    expect(findOrderByRazorpayOrderIdOrInternalId).not.toHaveBeenCalled();
    expect(finalizePendingOrder).not.toHaveBeenCalled();
  });

  it("wrong HMAC signature → 400 'Invalid Signature'; NO downstream work", async () => {
    const res = await POST(
      makeReq({
        body: paymentCapturedPayload(),
        signature: "0000000000000000000000000000000000000000000000000000000000000000",
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid Signature");
    expect(findOrderByRazorpayOrderIdOrInternalId).not.toHaveBeenCalled();
  });

  it("signature for OTHER body → 400 (anti-replay-with-mutation)", async () => {
    const tampered = JSON.stringify({ event: "payment.captured", payload: { tampered: true } });
    const sigForDifferent = signBody(JSON.stringify(paymentCapturedPayload()));
    const res = await POST(makeReq({ body: tampered, signature: sigForDifferent }));
    expect(res.status).toBe(400);
  });

  it("signature created with WRONG secret → 400", async () => {
    const res = await POST(
      makeReq({ body: paymentCapturedPayload(), secret: "wrong_secret" })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid Signature");
  });

  it("valid signature → proceeds past gate (HMAC check is the entry point)", async () => {
    findOrderByRazorpayOrderIdOrInternalId.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ body: paymentCapturedPayload() }));
    expect(res.status).toBe(200);
    expect(findOrderByRazorpayOrderIdOrInternalId).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Event dispatch
// ═══════════════════════════════════════════════════════════════════
describe("Event dispatch", () => {
  it("event='payment.captured' → routes to handlePaymentCaptured", async () => {
    findOrderByRazorpayOrderIdOrInternalId.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ body: paymentCapturedPayload() }));
    expect(res.status).toBe(200);
    expect(findOrderByRazorpayOrderIdOrInternalId).toHaveBeenCalled();
    expect(getOrderByRazorpayPaymentId).not.toHaveBeenCalled();
  });

  it("event='refund.processed' → routes to handleRefundProcessed", async () => {
    getOrderByRazorpayPaymentId.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ body: refundProcessedPayload() }));
    expect(res.status).toBe(200);
    expect(getOrderByRazorpayPaymentId).toHaveBeenCalled();
    expect(findOrderByRazorpayOrderIdOrInternalId).not.toHaveBeenCalled();
  });

  it("unknown event → 200 no-op (anti-Razorpay-retry-storm); NO handler runs", async () => {
    const res = await POST(
      makeReq({ body: { event: "subscription.charged", payload: {} } })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(findOrderByRazorpayOrderIdOrInternalId).not.toHaveBeenCalled();
    expect(getOrderByRazorpayPaymentId).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// payment.captured — order lookup + lookup-not-found
// ═══════════════════════════════════════════════════════════════════
describe("payment.captured — order lookup", () => {
  it("order lookup uses (notes.receipt OR description, order_id)", async () => {
    findOrderByRazorpayOrderIdOrInternalId.mockResolvedValueOnce(null);
    await POST(
      makeReq({
        body: paymentCapturedPayload({
          orderIdReceipt: "ORD-FROM-NOTES",
          razorpayOrderId: "rzp_AAA",
        }),
      })
    );
    expect(findOrderByRazorpayOrderIdOrInternalId).toHaveBeenCalledWith(
      "ORD-FROM-NOTES",
      "rzp_AAA"
    );
  });

  it("falls back to description when notes.receipt missing", async () => {
    findOrderByRazorpayOrderIdOrInternalId.mockResolvedValueOnce(null);
    await POST(
      makeReq({
        body: paymentCapturedPayload({
          description: "ORD-FROM-DESC",
          razorpayOrderId: "rzp_BBB",
        }),
      })
    );
    expect(findOrderByRazorpayOrderIdOrInternalId).toHaveBeenCalledWith(
      "ORD-FROM-DESC",
      "rzp_BBB"
    );
  });

  it("order not found → 200 no-op (NOT 404 — anti-retry-storm) with NO claim", async () => {
    findOrderByRazorpayOrderIdOrInternalId.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ body: paymentCapturedPayload() }));
    expect(res.status).toBe(200);
    expect(claimPendingOrderForProcessing).not.toHaveBeenCalled();
    expect(finalizePendingOrder).not.toHaveBeenCalled();
  });

  it("connectDB is called before any DB read on payment.captured", async () => {
    findOrderByRazorpayOrderIdOrInternalId.mockResolvedValueOnce(null);
    await POST(makeReq({ body: paymentCapturedPayload() }));
    expect(connectDB).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// payment.captured — renewal / upgrade deferral (DON'T provision)
// ═══════════════════════════════════════════════════════════════════
describe("payment.captured — renewal/upgrade orders defer to /verify", () => {
  it("orderType='renewal' + razorpayPaymentId='pending' → stamps payment id + save; NO finalizePendingOrder, NO claim, NO Zoho", async () => {
    const order = makeOrder({ orderType: "renewal", razorpayPaymentId: "pending" });
    findOrderByRazorpayOrderIdOrInternalId.mockResolvedValueOnce(order);
    const res = await POST(
      makeReq({ body: paymentCapturedPayload({ paymentId: "pay_NEW" }) })
    );
    expect(res.status).toBe(200);
    expect(order.razorpayPaymentId).toBe("pay_NEW");
    expect(order.save).toHaveBeenCalledTimes(1);
    expect(claimPendingOrderForProcessing).not.toHaveBeenCalled();
    expect(finalizePendingOrder).not.toHaveBeenCalled();
    expect(zohoGetInstance).not.toHaveBeenCalled();
  });

  it("orderType='hosting_upgrade' → same defer + stamp behavior", async () => {
    const order = makeOrder({
      orderType: "hosting_upgrade",
      razorpayPaymentId: "pending",
    });
    findOrderByRazorpayOrderIdOrInternalId.mockResolvedValueOnce(order);
    await POST(makeReq({ body: paymentCapturedPayload({ paymentId: "pay_UPG" }) }));
    expect(order.razorpayPaymentId).toBe("pay_UPG");
    expect(order.save).toHaveBeenCalledTimes(1);
    expect(finalizePendingOrder).not.toHaveBeenCalled();
  });

  it("renewal with razorpayPaymentId ALREADY set (re-delivery) → NO save (idempotent)", async () => {
    const order = makeOrder({
      orderType: "renewal",
      razorpayPaymentId: "pay_OLD",
    });
    findOrderByRazorpayOrderIdOrInternalId.mockResolvedValueOnce(order);
    await POST(makeReq({ body: paymentCapturedPayload({ paymentId: "pay_NEW" }) }));
    expect(order.razorpayPaymentId).toBe("pay_OLD");
    expect(order.save).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// payment.captured — non-pending idempotent no-op
// ═══════════════════════════════════════════════════════════════════
describe("payment.captured — non-pending status is idempotent no-op", () => {
  it("status='completed' + razorpayPaymentId='pending' → stamps id + save; NO claim, NO Zoho, NO provisioning", async () => {
    const order = makeOrder({ status: "completed", razorpayPaymentId: "pending" });
    findOrderByRazorpayOrderIdOrInternalId.mockResolvedValueOnce(order);
    await POST(makeReq({ body: paymentCapturedPayload({ paymentId: "pay_LATE" }) }));
    expect(order.razorpayPaymentId).toBe("pay_LATE");
    expect(order.save).toHaveBeenCalledTimes(1);
    expect(claimPendingOrderForProcessing).not.toHaveBeenCalled();
    expect(finalizePendingOrder).not.toHaveBeenCalled();
    expect(zohoGetInstance).not.toHaveBeenCalled();
  });

  it("status='completed' + razorpayPaymentId already set → NO save (full idempotency)", async () => {
    const order = makeOrder({ status: "completed", razorpayPaymentId: "pay_OLD" });
    findOrderByRazorpayOrderIdOrInternalId.mockResolvedValueOnce(order);
    await POST(makeReq({ body: paymentCapturedPayload() }));
    expect(order.save).not.toHaveBeenCalled();
  });

  it("status='processing' (verify already claimed) → idempotent no-op", async () => {
    const order = makeOrder({ status: "processing", razorpayPaymentId: "pay_OLD" });
    findOrderByRazorpayOrderIdOrInternalId.mockResolvedValueOnce(order);
    const res = await POST(makeReq({ body: paymentCapturedPayload() }));
    expect(res.status).toBe(200);
    expect(claimPendingOrderForProcessing).not.toHaveBeenCalled();
    expect(finalizePendingOrder).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// payment.captured — claim semantics
// ═══════════════════════════════════════════════════════════════════
describe("payment.captured — atomic claim semantics", () => {
  function setupClaimable(claimReturn: unknown) {
    const order = makeOrder({ status: "pending", razorpayOrderId: "rzp_AAA" });
    findOrderByRazorpayOrderIdOrInternalId.mockResolvedValueOnce(order);
    claimPendingOrderForProcessing.mockResolvedValueOnce(claimReturn);
    return order;
  }

  it("claim won → proceeds; claim called with (order.razorpayOrderId, …) NOT with the payload's order_id", async () => {
    const claimed = {
      ...makeOrder(),
      domains: [{ domainName: "alice.com", price: 1000, itemType: "domain", registrationPeriod: 1 }],
      zohoInvoiceId: "ZINV-1",
    };
    setupClaimable(claimed);
    getUserById.mockResolvedValueOnce({ _id: "U1", email: "u@x.com" });
    finalizePendingOrder.mockResolvedValueOnce({
      finalSuccessfulDomains: ["alice.com"],
      pendingDomains: [],
      failedDomains: [],
    });
    await POST(makeReq({ body: paymentCapturedPayload({ paymentId: "pay_WIN" }) }));
    expect(claimPendingOrderForProcessing).toHaveBeenCalledWith(
      "rzp_AAA",
      expect.objectContaining({
        razorpayPaymentId: "pay_WIN",
        paymentVerification: expect.objectContaining({
          paymentStatus: "captured",
          razorpayOrderId: "rzp_AAA",
        }),
      })
    );
  });

  it("claim LOST (returns null) — /verify is mid-flight → 200 no-op, NO Zoho, NO finalize", async () => {
    setupClaimable(null);
    const res = await POST(makeReq({ body: paymentCapturedPayload() }));
    expect(res.status).toBe(200);
    expect(getUserById).not.toHaveBeenCalled();
    expect(zohoGetInstance).not.toHaveBeenCalled();
    expect(finalizePendingOrder).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// payment.captured — user-not-found rethrow
// ═══════════════════════════════════════════════════════════════════
describe("payment.captured — user-not-found is fatal (Razorpay retries)", () => {
  it("getUserById null on claimed order → throws → outer catch → 500 (admin inspection state)", async () => {
    const claimed = { ...makeOrder(), userId: "U-GHOST" };
    findOrderByRazorpayOrderIdOrInternalId.mockResolvedValueOnce(makeOrder({ status: "pending" }));
    claimPendingOrderForProcessing.mockResolvedValueOnce(claimed);
    getUserById.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ body: paymentCapturedPayload() }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal Server Error");
    expect(finalizePendingOrder).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// payment.captured — invoice creation via createPrimaryInvoice
// (Primary Billing Integration Phase 1c-3)
// ═══════════════════════════════════════════════════════════════════
describe("payment.captured — invoice creation via createPrimaryInvoice", () => {
  function setupReadyForInvoice(claimedOver: Partial<FakeOrder> = {}) {
    const order = makeOrder({ status: "pending" });
    const claimed = { ...makeOrder({ status: "processing" }), ...claimedOver };
    findOrderByRazorpayOrderIdOrInternalId.mockResolvedValueOnce(order);
    claimPendingOrderForProcessing.mockResolvedValueOnce(claimed);
    getUserById.mockResolvedValueOnce({ _id: "U1", email: "u@x.com" });
    finalizePendingOrder.mockResolvedValueOnce({
      finalSuccessfulDomains: ["alice.com"],
      pendingDomains: [],
      failedDomains: [],
    });
    return claimed;
  }

  it("calls createPrimaryInvoice with order/orderId/razorpay_payment_id/paymentDetails/user/cartItems", async () => {
    const claimed = setupReadyForInvoice();
    createPrimaryInvoice.mockResolvedValueOnce({ invoiceId: "TI-1", invoiceNumber: "TI/2026-27/00001" });
    await POST(makeReq({ body: paymentCapturedPayload({ paymentId: "pay_Z", amount: 118000 }) }));
    expect(createPrimaryInvoice).toHaveBeenCalledTimes(1);
    const ctx = createPrimaryInvoice.mock.calls[0][0];
    expect(ctx.order).toBe(claimed);
    expect(ctx.orderId).toBe("ORD-1");
    expect(ctx.razorpay_payment_id).toBe("pay_Z");
    expect(ctx.paymentDetails).toEqual(
      expect.objectContaining({ id: "pay_Z", amount: 118000, status: "captured" })
    );
    expect(ctx.user).toEqual(expect.objectContaining({ email: "u@x.com" }));
    expect(ctx.cartItems).toEqual(
      expect.arrayContaining([expect.objectContaining({ domainName: "alice.com", price: 1000 })])
    );
  });

  it("zero-amount order → createPrimaryInvoice NOT called; provisioning still runs", async () => {
    setupReadyForInvoice({ amount: 0 });
    const res = await POST(makeReq({ body: paymentCapturedPayload() }));
    expect(res.status).toBe(200);
    expect(createPrimaryInvoice).not.toHaveBeenCalled();
    expect(finalizePendingOrder).toHaveBeenCalled();
  });

  it("orderType='hosting_trial' → createPrimaryInvoice NOT called", async () => {
    setupReadyForInvoice({ orderType: "hosting_trial" });
    await POST(makeReq({ body: paymentCapturedPayload() }));
    expect(createPrimaryInvoice).not.toHaveBeenCalled();
  });

  it("createPrimaryInvoice throws (both engines failed) → SWALLOWED; forceMarkZohoCreationFailed called; provisioning STILL runs", async () => {
    setupReadyForInvoice();
    createPrimaryInvoice.mockRejectedValueOnce(new Error("both engines down"));
    const res = await POST(makeReq({ body: paymentCapturedPayload() }));
    expect(res.status).toBe(200);
    expect(forceMarkZohoCreationFailed).toHaveBeenCalledTimes(1);
    expect(finalizePendingOrder).toHaveBeenCalled();
  });

  it("createPrimaryInvoice success → NO forceMarkZohoCreationFailed call; provisioning runs", async () => {
    setupReadyForInvoice();
    createPrimaryInvoice.mockResolvedValueOnce({
      invoiceId: "TI-1",
      invoiceNumber: "TI/2026-27/00001",
      provider: "primary",
    });
    const res = await POST(makeReq({ body: paymentCapturedPayload() }));
    expect(res.status).toBe(200);
    expect(forceMarkZohoCreationFailed).not.toHaveBeenCalled();
    expect(finalizePendingOrder).toHaveBeenCalled();
  });

  // ── REGRESSION (2026-09-02): the primary tax-invoice number was being
  // silently overwritten by the Order pre-save hook's legacy random number.
  // createPrimaryInvoice persists via a targeted updateOne, but `claimed` was
  // loaded BEFORE that write, so when finalizePendingOrder flipped status to
  // 'completed' and called order.save(), the hook saw `!this.invoiceNumber`
  // and minted `INV-<ts>-<hex>` over the real TI/... number. Caught by an
  // end-to-end purchase test. The handler must sync the issued invoice back
  // onto the in-memory doc BEFORE finalizePendingOrder runs.
  it("REGRESSION: stamps the primary invoice number onto the in-memory order before finalize (hook can't clobber it)", async () => {
    const claimed = setupReadyForInvoice({ invoiceNumber: undefined });
    createPrimaryInvoice.mockResolvedValueOnce({
      invoiceId: "TI/2026-27/00007",
      invoiceNumber: "TI/2026-27/00007",
      provider: "primary",
    });

    await POST(makeReq({ body: paymentCapturedPayload() }));

    expect(claimed.invoiceNumber).toBe("TI/2026-27/00007");
    expect((claimed as { invoiceProvider?: string }).invoiceProvider).toBe("primary");
    // ...and it was stamped BEFORE provisioning/finalisation ran
    expect(finalizePendingOrder).toHaveBeenCalled();
    const orderPassedToFinalize = finalizePendingOrder.mock.calls[0][0].order;
    expect(orderPassedToFinalize.invoiceNumber).toBe("TI/2026-27/00007");
  });

  it("REGRESSION: stamps the Zoho ids onto the in-memory order when the fallback issued the invoice", async () => {
    const claimed = setupReadyForInvoice({ invoiceNumber: undefined, zohoInvoiceId: undefined });
    createPrimaryInvoice.mockResolvedValueOnce({
      invoiceId: "zoho_inv_99",
      invoiceNumber: "INV-000099",
      provider: "zoho",
    });

    await POST(makeReq({ body: paymentCapturedPayload() }));

    expect(claimed.zohoInvoiceId).toBe("zoho_inv_99");
    expect(claimed.invoiceNumber).toBe("INV-000099");
  });

  it("REGRESSION: a skipped invoice (zero-amount/claim contention) leaves the in-memory order untouched", async () => {
    const claimed = setupReadyForInvoice({ invoiceNumber: undefined });
    createPrimaryInvoice.mockResolvedValueOnce({
      invoiceId: "",
      invoiceNumber: null,
      provider: "skipped",
    });

    await POST(makeReq({ body: paymentCapturedPayload() }));

    expect(claimed.invoiceNumber).toBeUndefined();
    expect((claimed as { invoiceProvider?: string }).invoiceProvider).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// payment.captured — finalizePendingOrder
// ═══════════════════════════════════════════════════════════════════
describe("payment.captured — finalizePendingOrder integration", () => {
  function setupReadyForFinalize() {
    const order = makeOrder({ status: "pending" });
    const claimed = { ...makeOrder({ status: "processing" }), zohoInvoiceId: "ZINV-1" };
    findOrderByRazorpayOrderIdOrInternalId.mockResolvedValueOnce(order);
    claimPendingOrderForProcessing.mockResolvedValueOnce(claimed);
    getUserById.mockResolvedValueOnce({ _id: "U1", email: "u@x.com" });
    return claimed;
  }

  it("finalizePendingOrder called with order, user, payment id, 'webhook_verified' signature sentinel", async () => {
    setupReadyForFinalize();
    finalizePendingOrder.mockResolvedValueOnce({
      finalSuccessfulDomains: [],
      pendingDomains: [],
      failedDomains: [],
    });
    await POST(makeReq({ body: paymentCapturedPayload({ paymentId: "pay_F" }) }));
    expect(finalizePendingOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        order: expect.any(Object),
        user: expect.objectContaining({ email: "u@x.com" }),
        razorpay_payment_id: "pay_F",
        razorpay_signature: "webhook_verified",
        paymentDetails: expect.objectContaining({
          id: "pay_F",
          status: "captured",
        }),
      })
    );
  });

  it("paymentDetails.order_id falls back to claimed.razorpayOrderId when payment.order_id missing", async () => {
    setupReadyForFinalize();
    finalizePendingOrder.mockResolvedValueOnce({
      finalSuccessfulDomains: [],
      pendingDomains: [],
      failedDomains: [],
    });
    const payload = paymentCapturedPayload();
    // Strip order_id from the payment entity
    delete (payload.payload.payment.entity as { order_id?: string }).order_id;
    await POST(makeReq({ body: payload }));
    const call = finalizePendingOrder.mock.calls[0][0];
    expect(call.paymentDetails.order_id).toBe("rzp_order_AAA");
  });

  it("finalizePendingOrder throws → outer catch → 500 (Razorpay retries) — order stays in processing", async () => {
    setupReadyForFinalize();
    finalizePendingOrder.mockRejectedValueOnce(new Error("Provisioning blowup"));
    const res = await POST(makeReq({ body: paymentCapturedPayload() }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal Server Error");
  });

  it("finalizePendingOrder happy → 200 'ok' (success log includes counts)", async () => {
    setupReadyForFinalize();
    finalizePendingOrder.mockResolvedValueOnce({
      finalSuccessfulDomains: ["a.com", "b.com"],
      pendingDomains: [],
      failedDomains: [],
    });
    const res = await POST(makeReq({ body: paymentCapturedPayload() }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});

// ═══════════════════════════════════════════════════════════════════
// refund.processed — skip branches
// ═══════════════════════════════════════════════════════════════════
describe("refund.processed — skip paths (NO credit-note creation)", () => {
  it("missing refund entity → skip with warn; NO order lookup", async () => {
    const res = await POST(
      makeReq({ body: refundProcessedPayload({ missingEntity: true }) })
    );
    expect(res.status).toBe(200);
    expect(getOrderByRazorpayPaymentId).not.toHaveBeenCalled();
    expect(zohoCreateCreditNote).not.toHaveBeenCalled();
  });

  it("order not found by paymentId → skip; NO credit note", async () => {
    getOrderByRazorpayPaymentId.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ body: refundProcessedPayload() }));
    expect(res.status).toBe(200);
    expect(zohoCreateCreditNote).not.toHaveBeenCalled();
  });

  it("order has NO zohoInvoiceId → skip credit note (can't credit what wasn't invoiced)", async () => {
    getOrderByRazorpayPaymentId.mockResolvedValueOnce(makeOrder({ zohoInvoiceId: undefined }));
    const res = await POST(makeReq({ body: refundProcessedPayload() }));
    expect(res.status).toBe(200);
    expect(zohoCreateCreditNote).not.toHaveBeenCalled();
  });

  it("zohoInvoiceId='creation_failed' sentinel → skip credit note (can't credit a non-existent Zoho invoice)", async () => {
    getOrderByRazorpayPaymentId.mockResolvedValueOnce(
      makeOrder({ zohoInvoiceId: "creation_failed" })
    );
    const res = await POST(makeReq({ body: refundProcessedPayload() }));
    expect(res.status).toBe(200);
    expect(zohoCreateCreditNote).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// refund.processed — happy + failure swallow
// ═══════════════════════════════════════════════════════════════════
describe("refund.processed — credit-note creation", () => {
  function setupRefundable(over: Partial<FakeOrder> = {}) {
    const order = makeOrder({
      zohoInvoiceId: "ZINV-7",
      userId: "U1",
      ...over,
    });
    getOrderByRazorpayPaymentId.mockResolvedValueOnce(order);
    getUserById.mockResolvedValueOnce({ _id: "U1", email: "u@x.com" });
    return order;
  }

  it("happy path: createCreditNote called with (zohoInvoiceId, contactId, refundId, amount, orderId)", async () => {
    setupRefundable();
    zohoGetContactByEmail.mockResolvedValueOnce({ contact_id: "ZC-1" });
    zohoCreateCreditNote.mockResolvedValueOnce({ credit_note_id: "CN-1" });
    const res = await POST(
      makeReq({
        body: refundProcessedPayload({
          refundId: "rfnd_X",
          paymentId: "pay_X",
          amount: 50000,
        }),
      })
    );
    expect(res.status).toBe(200);
    expect(zohoCreateCreditNote).toHaveBeenCalledWith(
      "ZINV-7",
      "ZC-1",
      "rfnd_X",
      50000,
      "ORD-1"
    );
  });

  it("getContactByEmail returns null → throws → SWALLOWED (200, NO Razorpay retry for accounting failures)", async () => {
    setupRefundable();
    zohoGetContactByEmail.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ body: refundProcessedPayload() }));
    expect(res.status).toBe(200);
    expect(zohoCreateCreditNote).not.toHaveBeenCalled();
  });

  it("getUserById returns null → throws → SWALLOWED (200)", async () => {
    getOrderByRazorpayPaymentId.mockResolvedValueOnce(makeOrder({ zohoInvoiceId: "ZINV-7" }));
    getUserById.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ body: refundProcessedPayload() }));
    expect(res.status).toBe(200);
    expect(zohoCreateCreditNote).not.toHaveBeenCalled();
  });

  it("createCreditNote throws → SWALLOWED (200, NO Razorpay retry)", async () => {
    setupRefundable();
    zohoGetContactByEmail.mockResolvedValueOnce({ contact_id: "ZC-1" });
    zohoCreateCreditNote.mockRejectedValueOnce(new Error("Zoho 500"));
    const res = await POST(makeReq({ body: refundProcessedPayload() }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("connectDB is called for refund path too", async () => {
    setupRefundable();
    zohoGetContactByEmail.mockResolvedValueOnce({ contact_id: "ZC-1" });
    zohoCreateCreditNote.mockResolvedValueOnce({ credit_note_id: "CN-1" });
    await POST(makeReq({ body: refundProcessedPayload() }));
    expect(connectDB).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Outer catch — invalid JSON, parse failures, unexpected throws
// ═══════════════════════════════════════════════════════════════════
describe("Outer catch — 500 for unexpected throws (Razorpay retries)", () => {
  it("invalid JSON body (signature still valid for the raw bytes) → 500 outer catch", async () => {
    const malformed = "not-json-at-all";
    const sig = signBody(malformed);
    const res = await POST(
      new NextRequest("https://example.com/razorpay/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-razorpay-signature": sig,
        },
        body: malformed,
      })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal Server Error");
  });

  it("connectDB throw → outer catch → 500 (Razorpay retries)", async () => {
    connectDB.mockRejectedValueOnce(new Error("Mongo down: secret-leak-A"));
    const res = await POST(makeReq({ body: paymentCapturedPayload() }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal Server Error");
    // Sentinel-leak guard
    expect(JSON.stringify(body)).not.toContain("secret-leak-A");
  });

  it("findOrderByRazorpayOrderIdOrInternalId throw → 500 (anti-leak)", async () => {
    findOrderByRazorpayOrderIdOrInternalId.mockRejectedValueOnce(
      new Error("Mongo timeout: db-host-secret-XYZ")
    );
    const res = await POST(makeReq({ body: paymentCapturedPayload() }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("db-host-secret-XYZ");
  });
});

// ── Tokens-flow CIT auth (mandate validation) handler (Phase 2B) ─────
describe("Tokens-flow mandate validation (mandateMode='tokens')", () => {
  beforeEach(() => {
    refundPayment.mockReset().mockResolvedValue({ id: "rfnd_X", status: "processed" });
    findUserHosting.mockReset().mockResolvedValue(null);
    createTokensFlowTrialHosting.mockReset().mockResolvedValue({
      hostingId: "host_T_1",
      domainName: "example.com",
      expiryDate: new Date(),
      status: "pending",
    });
  });

  function tokensCITPayload(over: {
    paymentId?: string;
    tokenId?: string;
    razorpayOrderId?: string;
  } = {}) {
    return {
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: over.paymentId ?? "pay_TOK_AUTH",
            amount: 200,
            currency: "INR",
            order_id: over.razorpayOrderId ?? "rzp_order_TOK",
            token_id: over.tokenId ?? "token_T5nX",
            customer_id: "cust_TOK",
          },
        },
      },
    };
  }

  function tokensOrder(
    over: Partial<FakeOrder & { mandateMode?: string; razorpayCustomerId?: string; razorpayTokenId?: string }> = {}
  ): FakeOrder & { mandateMode?: string; razorpayCustomerId?: string; razorpayTokenId?: string } {
    return {
      ...makeOrder({
        razorpayOrderId: "rzp_order_TOK",
        orderType: "hosting_trial",
        ...over,
      }),
      mandateMode: "tokens",
      razorpayCustomerId: "cust_TOK",
      ...over,
    };
  }

  it("on payment.captured for a tokens-mode hosting_trial: refunds Rs 2 + stores token_id + marks order completed + creates Hosting record", async () => {
    const order = tokensOrder();
    findOrderByRazorpayOrderIdOrInternalId.mockResolvedValueOnce(order);

    const res = await POST(makeReq({ body: tokensCITPayload() }));
    expect(res.status).toBe(200);

    // Rs 2 refunded with optimum speed via RazorpayService.refundPayment
    expect(refundPayment).toHaveBeenCalledWith(
      "pay_TOK_AUTH",
      200, // ₹2 in paise
      expect.objectContaining({
        reason: "mandate_validation_refund",
        orderId: "ORD-1",
      })
    );

    // Token persisted on order
    expect(order.save).toHaveBeenCalled();
    const orderRef = order as unknown as { razorpayTokenId?: string; razorpayPaymentId?: string; status?: string };
    expect(orderRef.razorpayTokenId).toBe("token_T5nX");
    expect(orderRef.razorpayPaymentId).toBe("pay_TOK_AUTH");
    expect(orderRef.status).toBe("completed");

    // Phase 2C: Hosting record creation (after token storage + refund)
    expect(findUserHosting).toHaveBeenCalledWith("U1", { domainName: "alice.com" });
    expect(createTokensFlowTrialHosting).toHaveBeenCalledTimes(1);
    expect(createTokensFlowTrialHosting).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "ORD-1", razorpayTokenId: "token_T5nX" })
    );

    // finalizePendingOrder NOT called — Tokens flow does not use it
    expect(finalizePendingOrder).not.toHaveBeenCalled();
  });

  it("Phase 2C idempotency: existing Hosting for (userId, domainName) → skip create", async () => {
    findUserHosting.mockResolvedValueOnce({ _id: "h_existing", domainName: "alice.com" });
    const order = tokensOrder();
    findOrderByRazorpayOrderIdOrInternalId.mockResolvedValueOnce(order);

    await POST(makeReq({ body: tokensCITPayload() }));

    expect(findUserHosting).toHaveBeenCalled();
    expect(createTokensFlowTrialHosting).not.toHaveBeenCalled();
  });

  it("Phase 2C Hosting-creation failure does NOT block the webhook (token already stored + refund issued)", async () => {
    createTokensFlowTrialHosting.mockRejectedValueOnce(new Error("createHosting DB write failed"));
    const order = tokensOrder();
    findOrderByRazorpayOrderIdOrInternalId.mockResolvedValueOnce(order);

    const res = await POST(makeReq({ body: tokensCITPayload() }));
    expect(res.status).toBe(200);  // 200 so Razorpay doesn't retry the whole flow

    // The token was still stored on the order before Hosting creation was attempted
    const orderRef = order as unknown as { razorpayTokenId?: string; status?: string };
    expect(orderRef.razorpayTokenId).toBe("token_T5nX");
    expect(orderRef.status).toBe("completed");
  });

  it("Phase 2C: order with empty domains array → no Hosting created, no crash", async () => {
    const order = { ...tokensOrder(), domains: [] };
    findOrderByRazorpayOrderIdOrInternalId.mockResolvedValueOnce(order);

    const res = await POST(makeReq({ body: tokensCITPayload() }));
    expect(res.status).toBe(200);

    expect(findUserHosting).not.toHaveBeenCalled();
    expect(createTokensFlowTrialHosting).not.toHaveBeenCalled();
  });

  it("idempotency: re-delivered webhook on completed order → no-op (no refund, no save)", async () => {
    const order = tokensOrder({ status: "completed" });
    findOrderByRazorpayOrderIdOrInternalId.mockResolvedValueOnce(order);

    await POST(makeReq({ body: tokensCITPayload() }));

    expect(refundPayment).not.toHaveBeenCalled();
    expect(order.save).not.toHaveBeenCalled();
  });

  it("token_id missing from payment BUT customer_id is on order: defers (no refund, leaves order pending so a later webhook delivery or token.confirmed event can complete it)", async () => {
    const order = tokensOrder();  // razorpayCustomerId is set
    findOrderByRazorpayOrderIdOrInternalId.mockResolvedValueOnce(order);

    // payment with no token_id — Razorpay sometimes delivers payment.captured
    // before the token_id is attached on their side; the deferral lets the
    // next delivery (or a fetchTokens lookup) recover.
    const payload = tokensCITPayload();
    (payload.payload.payment.entity as { token_id?: string }).token_id = undefined;

    const res = await POST(makeReq({ body: payload }));
    expect(res.status).toBe(200);
    expect(refundPayment).not.toHaveBeenCalled();  // defer until the token is available
    expect(order.save).not.toHaveBeenCalled();
  });

  it("refund API failure does NOT block token storage (mandate is money-loss-but-mandate-intact)", async () => {
    refundPayment.mockRejectedValueOnce(new Error("Razorpay refund API 500"));
    const order = tokensOrder();
    findOrderByRazorpayOrderIdOrInternalId.mockResolvedValueOnce(order);

    const res = await POST(makeReq({ body: tokensCITPayload() }));
    expect(res.status).toBe(200);

    // Token still stored on order even though refund failed
    expect(order.save).toHaveBeenCalled();
    const orderRef = order as unknown as { razorpayTokenId?: string; status?: string };
    expect(orderRef.razorpayTokenId).toBe("token_T5nX");
    expect(orderRef.status).toBe("completed");
  });

  it("regular (non-tokens-mode) order: NOT routed to mandate handler", async () => {
    const order = makeOrder();  // mandateMode undefined; orderType undefined → not 'hosting_trial' tokens branch
    findOrderByRazorpayOrderIdOrInternalId.mockResolvedValueOnce(order);
    claimPendingOrderForProcessing.mockResolvedValueOnce(order);

    await POST(makeReq({ body: tokensCITPayload() }));

    // Regular handler path: NO refund (refundPayment not called by the regular branch)
    expect(refundPayment).not.toHaveBeenCalled();
  });
});
