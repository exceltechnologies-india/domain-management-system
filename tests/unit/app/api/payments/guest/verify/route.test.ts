/**
 * Tests for `app/api/payments/guest/verify/route.ts` (rescan-4 slice
 * 7fz). Guest-checkout variant of /verify — same security boundaries
 * as the logged-in path but with extra guards because the actor is
 * unauthenticated. Pins:
 *  - **Rate-limit FIRST** (unauthenticated path that hits Razorpay
 *    + DB on every call — 5/min IP cap)
 *  - **Guest token validation**: verifyGuestToken null → 401
 *    'Guest session expired'
 *  - **Trial-block**: cartItems with isTrial → 400 'Free trials
 *    require an account' (1-per-user-lifetime eligibility needs a
 *    real account; paid hosting + domains are fine for guests)
 *  - **Signature verification**: verifyPayment false → 400 'Invalid
 *    payment signature'
 *  - **getPaymentDetails throw** → 400 'Failed to verify payment
 *    status'; non-captured/authorized status → 400 with status
 *  - **paymentDetails.order_id mismatch** → 400 'Order ID mismatch'
 *  - **Email ownership defense-in-depth**: existingOrder.userEmail
 *    !== guestEmail (case-insensitive) → 404 'Order not found' (a
 *    malformed call path that skipped /create-order must not bind
 *    a paid order to a victim's email)
 *  - **Already-completed early-exit**: 'Order already completed' +
 *    isGuest:true
 *  - **paid/processing**: 'provisioning in progress' + domain
 *    RegistrationStatus:'processing'
 *  - **Amount-match check** fires on pending orders (anti-
 *    underpayment — mirrors logged-in path)
 *  - **Domain support check** (requiresAdditionalDetails / isDomain
 *    Supported) → 400 contact-support message; hosting items SKIP
 *    the check (they don't go through RC)
 *  - **Email-claim defense**: existing non-guest user with same
 *    email → 409 'sign in to continue' (last fence — /create-order
 *    already gates this, but verify must hold the line too)
 *  - **createUser for new guest**: random unusable password,
 *    isGuest:true, profileCompleted:true, provider:'credentials'
 *  - **Backfill**: existing guest user with !profileCompleted →
 *    backfills from token, saves
 *  - **finalizePendingOrder NOT passed cartItems** (H1 mirror —
 *    DB-trusted cart only)
 *  - **Pending claim race**: claim failure → 'processing' response
 *    (webhook beat us); claim success → finalize
 *  - **Legacy path**: no pending Order → provisionCartItems +
 *    dbSession.withTransaction (createOrder + createPayment atomic)
 *  - **cartItemsFromOrderDomains for Zoho** (anti-swap-domain H1
 *    mirror — Zoho/GST record matches what was actually sold)
 *  - **Zoho failure SWALLOWED** + recordSystemLog + force-mark-
 *    creation-failed
 *  - **Setup-password email** ONLY for new guest accounts (isGuest=
 *    true) — sets resetToken + 24h expiry, sends async (fire-and-
 *    forget — order is already provisioned)
 *  - **Catch path**: provisioning failed AFTER signature/status
 *    checks passed (those return inline, don't throw) → create
 *    fallback Order with status:'processing' + 'Provisioning failed
 *    — please contact support' messages; getOrderByOrderId dedup
 *    check BEFORE createOrder (anti-duplicate-key error)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── hoisted mocks ────────────────────────────────────────────────────
const verifyGuestToken = vi.hoisted(() => vi.fn());
vi.mock("@/lib/guest-token", () => ({ verifyGuestToken }));

const verifyPayment = vi.hoisted(() => vi.fn());
const getPaymentDetails = vi.hoisted(() => vi.fn());
vi.mock("@/lib/razorpay", () => ({
  RazorpayService: { verifyPayment, getPaymentDetails },
}));

const connectDB = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

const startSession = vi.hoisted(() =>
  vi.fn(async () => ({
    withTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    endSession: vi.fn(),
  }))
);
vi.mock("mongoose", () => ({
  default: { startSession },
  startSession,
}));

const createUser = vi.hoisted(() => vi.fn());
const getUserByEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ createUser, getUserByEmail }));

const claimPendingOrderForProcessing = vi.hoisted(() => vi.fn());
const createOrder = vi.hoisted(() => vi.fn());
const createOrderInSession = vi.hoisted(() => vi.fn());
const forceMarkZohoCreationFailed = vi.hoisted(() => vi.fn());
const getOrderByOrderId = vi.hoisted(() => vi.fn());
const getOrderByRazorpayOrderId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  claimPendingOrderForProcessing,
  createOrder,
  createOrderInSession,
  forceMarkZohoCreationFailed,
  getOrderByOrderId,
  getOrderByRazorpayOrderId,
}));

const createPaymentInTransaction = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/payments", () => ({ createPaymentInTransaction }));

const provisionCartItems = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/payment/provisioner", () => ({ provisionCartItems }));

const finalizePendingOrder = vi.hoisted(() => vi.fn());
const cartItemsFromOrderDomains = vi.hoisted(() => vi.fn(() => []));
vi.mock("@/lib/services/payment/order-creator", () => ({
  finalizePendingOrder,
  cartItemsFromOrderDomains,
}));

const validateOrderAmountMatchesRazorpay = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/payment/verification", () => ({
  validateOrderAmountMatchesRazorpay,
}));

const createZohoInvoice = vi.hoisted(() => vi.fn());
const runPostPaymentTasks = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/payment/post-tasks", () => ({
  createZohoInvoice,
  runPostPaymentTasks,
}));

// createPrimaryInvoice is PRIMARY_BILLING_ENABLED-gated pass-through to
// createZohoInvoice when the flag is off (the default, and this test suite
// never sets it) — forward to the same mock so every existing
// createZohoInvoice assertion below keeps working unchanged, without
// loading the real billing-engine module graph (models/Counter, mongoose
// Schema, mongodb connect) into a route unit test that already replaces
// mongoose with a minimal transaction-only stub above.
const createPrimaryInvoice = vi.hoisted(() =>
  vi.fn((ctx: unknown, opts: unknown) => createZohoInvoice(ctx, opts))
);
vi.mock("@/lib/services/billing/createPrimaryInvoice", () => ({
  createPrimaryInvoice,
}));

const recordSystemLog = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/system-logs", () => ({ recordSystemLog }));

const rlIsAllowed = vi.hoisted(() => vi.fn());
const rateLimitResponse = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rate-limit", () => ({
  rateLimiters: { guestCheckout: { isAllowed: rlIsAllowed } },
  rateLimitResponse,
}));

const isDomainSupported = vi.hoisted(() => vi.fn(() => true));
const requiresAdditionalDetails = vi.hoisted(() => vi.fn(() => false));
vi.mock("@/lib/domainRequirements", () => ({
  isDomainSupported,
  requiresAdditionalDetails,
}));

const sendPasswordResetEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  EmailService: { sendPasswordResetEmail },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/payments/guest/verify/route";

// ── helpers ──────────────────────────────────────────────────────────
function makeReq(body: unknown) {
  return new NextRequest("https://example.com/api/payments/guest/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validBody = {
  guestToken: "guest_tok_X",
  razorpay_order_id: "order_RP1",
  razorpay_payment_id: "pay_RP1",
  razorpay_signature: "sig_RP1",
  cartItems: [
    { domainName: "ex.com", price: 999, currency: "INR", itemType: "domain" },
  ],
};

const validTokenPayload = {
  email: "guest@x.com",
  firstName: "First",
  lastName: "Last",
  phone: "9876543210",
  addressLine1: "1 St",
  city: "City",
  state: "St",
  zipcode: "00000",
};

const validPaymentDetails = {
  status: "captured",
  amount: 99900,
  currency: "INR",
  order_id: "order_RP1",
};

beforeEach(() => {
  rlIsAllowed.mockReset().mockResolvedValue({ allowed: true });
  rateLimitResponse.mockReset();
  verifyGuestToken.mockReset().mockReturnValue(validTokenPayload);
  verifyPayment.mockReset().mockReturnValue(true);
  getPaymentDetails.mockReset().mockResolvedValue(validPaymentDetails);
  getUserByEmail.mockReset().mockResolvedValue(null);
  createUser.mockReset().mockResolvedValue({
    _id: "U_NEW",
    email: "guest@x.com",
    firstName: "First",
    lastName: "Last",
    isGuest: true,
    profileCompleted: true,
    save: vi.fn().mockResolvedValue(undefined),
  });
  claimPendingOrderForProcessing.mockReset();
  createOrder.mockReset();
  createOrderInSession.mockReset();
  forceMarkZohoCreationFailed.mockReset().mockResolvedValue(undefined);
  getOrderByOrderId.mockReset();
  getOrderByRazorpayOrderId.mockReset().mockResolvedValue(null);
  createPaymentInTransaction.mockReset().mockResolvedValue(undefined);
  provisionCartItems.mockReset().mockResolvedValue({
    orderDomains: [{ domainName: "ex.com", status: "registered" }],
    finalSuccessfulDomains: ["ex.com"],
  });
  finalizePendingOrder.mockReset();
  cartItemsFromOrderDomains.mockReset().mockReturnValue([]);
  validateOrderAmountMatchesRazorpay
    .mockReset()
    .mockResolvedValue({ ok: true });
  createZohoInvoice.mockReset().mockResolvedValue(undefined);
  runPostPaymentTasks.mockReset().mockResolvedValue(undefined);
  recordSystemLog.mockReset().mockResolvedValue(undefined);
  isDomainSupported.mockReset().mockReturnValue(true);
  requiresAdditionalDetails.mockReset().mockReturnValue(false);
  sendPasswordResetEmail.mockReset().mockResolvedValue(true);
});

function setupLegacyHappyPath() {
  createOrderInSession.mockResolvedValueOnce({
    _id: "OID-1",
    orderId: "ORD-1",
    domains: [{ domainName: "ex.com" }],
  });
}

// ─── Rate-limit gate ────────────────────────────────────────────────
describe("Rate-limit gate — FIRST check", () => {
  it("not allowed → rateLimitResponse returned (NO downstream)", async () => {
    const rlResp = NextResponse.json(
      { error: "Too many" },
      { status: 429 }
    );
    rlIsAllowed.mockResolvedValueOnce({ allowed: false });
    rateLimitResponse.mockReturnValueOnce(rlResp);
    const res = await POST(makeReq(validBody));
    expect(res).toBe(rlResp);
    expect(verifyGuestToken).not.toHaveBeenCalled();
  });

  it("rate-limit limit pinned at 5/min with descriptive message", async () => {
    rlIsAllowed.mockResolvedValueOnce({ allowed: false });
    rateLimitResponse.mockReturnValueOnce(
      NextResponse.json({}, { status: 429 })
    );
    await POST(makeReq(validBody));
    const opts = rateLimitResponse.mock.calls[0][1];
    expect(opts.limit).toBe(5);
    expect(opts.message).toMatch(/Too many verification attempts/);
  });
});

// ─── Guest token validation ────────────────────────────────────────
describe("Guest token validation", () => {
  it("invalid token → 401 'Guest session expired'", async () => {
    verifyGuestToken.mockReturnValueOnce(null);
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/Guest session expired/);
  });

  it("schema: missing guestToken → 400", async () => {
    const res = await POST(makeReq({ ...validBody, guestToken: "" }));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

// ─── Trial-block ───────────────────────────────────────────────────
describe("Trial-block — guest can't claim trials", () => {
  it("cartItems with isTrial:true → 400 'Free trials require an account'", async () => {
    const res = await POST(
      makeReq({
        ...validBody,
        cartItems: [
          {
            domainName: "host-x",
            price: 0,
            currency: "INR",
            itemType: "hosting" as const,
            isTrial: true,
          },
        ],
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Free trials require an account/);
  });
});

// ─── Signature verification ────────────────────────────────────────
describe("Razorpay signature verification", () => {
  it("verifyPayment returns false → 400 'Invalid payment signature'", async () => {
    verifyPayment.mockReturnValueOnce(false);
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid payment signature");
    expect(getPaymentDetails).not.toHaveBeenCalled();
  });
});

// ─── getPaymentDetails ────────────────────────────────────────────
describe("Razorpay payment-details fetch", () => {
  it("getPaymentDetails throw → 400 'Failed to verify payment status'", async () => {
    getPaymentDetails.mockRejectedValueOnce(new Error("RP down"));
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Failed to verify payment status");
  });

  it("status NOT captured/authorized → 400 with status", async () => {
    getPaymentDetails.mockResolvedValueOnce({
      ...validPaymentDetails,
      status: "failed",
    });
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/failed/);
  });

  it("'authorized' status passes (Razorpay state — payment authorized but not yet captured)", async () => {
    getPaymentDetails.mockResolvedValueOnce({
      ...validPaymentDetails,
      status: "authorized",
    });
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setupLegacyHappyPath();

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
  });

  it("paymentDetails.order_id mismatch → 400 'Order ID mismatch'", async () => {
    getPaymentDetails.mockResolvedValueOnce({
      ...validPaymentDetails,
      order_id: "order_OTHER",
    });
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Order ID mismatch");
  });
});

// ─── Email ownership defense ───────────────────────────────────────
describe("Email ownership defense-in-depth", () => {
  it("existingOrder.userEmail !== guestEmail → 404 'Order not found' (case-insensitive)", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce({
      orderId: "ORD-foreign",
      status: "pending",
      userEmail: "OTHER@x.com",
    });
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Order not found");
  });

  it("same email different case → passes (case-insensitive compare)", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce({
      orderId: "ORD-1",
      status: "completed",
      userEmail: "GUEST@X.COM", // uppercase variant
    });
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
  });
});

// ─── Already-completed / processing ────────────────────────────────
describe("Already-completed / processing early-exits", () => {
  it("status 'completed' → success message + isGuest:true", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce({
      orderId: "ORD-1",
      status: "completed",
      userEmail: "guest@x.com",
    });
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe("Order already completed");
    expect(body.isGuest).toBe(true);
    expect(body.orderId).toBe("ORD-1");
    expect(getUserByEmail).not.toHaveBeenCalled();
  });

  it.each(["paid", "processing"])(
    "status '%s' → 'provisioning in progress' + domainRegistrationStatus:'processing'",
    async (status) => {
      getOrderByRazorpayOrderId.mockResolvedValueOnce({
        orderId: "ORD-1",
        status,
        userEmail: "guest@x.com",
      });
      const res = await POST(makeReq(validBody));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.message).toMatch(/provisioning in progress/);
      expect(body.domainRegistrationStatus).toBe("processing");
    }
  );
});

// ─── Amount-match check ────────────────────────────────────────────
describe("Amount-match check — anti-underpayment", () => {
  it("fires on pending orders", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce({
      orderId: "ORD-1",
      status: "pending",
      userEmail: "guest@x.com",
    });
    validateOrderAmountMatchesRazorpay.mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json(
        { error: "amount mismatch" },
        { status: 400 }
      ),
    });
    const res = await POST(makeReq(validBody));
    expect(validateOrderAmountMatchesRazorpay).toHaveBeenCalled();
    expect(res.status).toBe(400);
  });

  it("does NOT fire when no existing order", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setupLegacyHappyPath();

    await POST(makeReq(validBody));
    expect(validateOrderAmountMatchesRazorpay).not.toHaveBeenCalled();
  });
});

// ─── Domain support check ──────────────────────────────────────────
describe("Domain support check", () => {
  it("requiresAdditionalDetails:true → 400 contact-support message", async () => {
    requiresAdditionalDetails.mockReturnValueOnce(true);
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/contact/);
  });

  it("isDomainSupported:false → 400 contact-support message", async () => {
    isDomainSupported.mockReturnValueOnce(false);
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(400);
  });

  it("hosting items SKIP the check (don't go through RC)", async () => {
    await POST(
      makeReq({
        ...validBody,
        cartItems: [
          {
            domainName: "host-x",
            price: 1500,
            currency: "INR",
            itemType: "hosting" as const,
          },
        ],
      })
    );
    expect(requiresAdditionalDetails).not.toHaveBeenCalled();
    expect(isDomainSupported).not.toHaveBeenCalled();
  });
});

// ─── Email-claim defense ───────────────────────────────────────────
describe("Email-claim defense — last fence", () => {
  it("existing NON-guest user with same email → 409 'sign in to continue'", async () => {
    getUserByEmail.mockResolvedValueOnce({
      _id: "U-REAL",
      email: "guest@x.com",
      isGuest: false,
    });
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/sign in to continue/);
    expect(createOrderInSession).not.toHaveBeenCalled();
  });
});

// ─── User upsert ───────────────────────────────────────────────────
describe("Guest user upsert", () => {
  it("new email → createUser with isGuest:true, profileCompleted:true, provider:'credentials'", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setupLegacyHappyPath();

    await POST(makeReq(validBody));

    const payload = createUser.mock.calls[0][0];
    expect(payload.isGuest).toBe(true);
    expect(payload.profileCompleted).toBe(true);
    expect(payload.provider).toBe("credentials");
    expect(payload.role).toBe("user");
    expect(payload.isActive).toBe(true);
    expect(payload.isActivated).toBe(true);
  });

  it("new email: random unusable password (32 hex bytes = 64 chars)", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setupLegacyHappyPath();

    await POST(makeReq(validBody));
    const payload = createUser.mock.calls[0][0];
    expect(payload.password).toMatch(/^[a-f0-9]{64}$/);
  });

  it("new email: address from token payload + country:'IN' + phoneCc:'+91'", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setupLegacyHappyPath();

    await POST(makeReq(validBody));
    const payload = createUser.mock.calls[0][0];
    expect(payload.address.country).toBe("IN");
    expect(payload.phoneCc).toBe("+91");
    expect(payload.address.line1).toBe("1 St");
  });

  it("new guest: WhatsApp number persisted (mirrors phone) so it doubles as contact", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setupLegacyHappyPath();

    await POST(makeReq(validBody));
    const payload = createUser.mock.calls[0][0];
    expect(payload.whatsappNumber).toBe(payload.phone);
    expect(payload.whatsappNumber).toBeTruthy();
  });

  it("**existing guest with !profileCompleted → backfilled from token + saved**", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const existingGuest = {
      _id: "U-EXISTING",
      email: "guest@x.com",
      isGuest: true,
      profileCompleted: false,
      firstName: "", // empty so token fills in
      lastName: "",
      phone: "",
      address: {},
      save,
    };
    getUserByEmail.mockResolvedValueOnce(existingGuest);
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setupLegacyHappyPath();

    await POST(makeReq(validBody));
    expect(existingGuest.firstName).toBe("First"); // backfilled
    expect(existingGuest.lastName).toBe("Last");
    expect(existingGuest.profileCompleted).toBe(true);
    expect(save).toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
  });
});

// ─── Pending claim ─────────────────────────────────────────────────
describe("Pending-order claim — race + DB-trusted cart", () => {
  it("**finalizePendingOrder is NOT passed cartItems** (H1 mirror — DB-trusted only)", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce({
      orderId: "ORD-1",
      status: "pending",
      userEmail: "guest@x.com",
    });
    claimPendingOrderForProcessing.mockResolvedValueOnce({
      _id: "OID-1",
      orderId: "ORD-1",
      domains: [{ domainName: "ex.com" }],
    });
    finalizePendingOrder.mockResolvedValueOnce({
      order: { _id: "OID-1", orderId: "ORD-1", domains: [] },
      orderId: "ORD-1",
      orderDomains: [],
      finalSuccessfulDomains: [],
    });

    await POST(makeReq(validBody));
    const finalizeArgs = finalizePendingOrder.mock.calls[0][0];
    expect(finalizeArgs).not.toHaveProperty("cartItems");
  });

  it("claim failure (webhook beat us) → 'processing' response with isGuest", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce({
      orderId: "ORD-1",
      status: "pending",
      userEmail: "guest@x.com",
    });
    claimPendingOrderForProcessing.mockResolvedValueOnce(null);

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toMatch(/provisioning in progress/);
    expect(body.domainRegistrationStatus).toBe("processing");
    expect(body.isGuest).toBe(true);
    expect(finalizePendingOrder).not.toHaveBeenCalled();
  });
});

// ─── Legacy provisionCartItems path ────────────────────────────────
describe("Legacy provision path — no pending order found", () => {
  it("provisionCartItems called when no pending order", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setupLegacyHappyPath();

    await POST(makeReq(validBody));
    expect(provisionCartItems).toHaveBeenCalled();
    expect(claimPendingOrderForProcessing).not.toHaveBeenCalled();
  });

  it("createOrderInSession + createPaymentInTransaction run in mongoose transaction", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setupLegacyHappyPath();

    await POST(makeReq(validBody));
    expect(createOrderInSession).toHaveBeenCalled();
    expect(createPaymentInTransaction).toHaveBeenCalled();
    expect(startSession).toHaveBeenCalled();
  });

  it("legacy path: orderId starts with 'ord_'", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setupLegacyHappyPath();

    await POST(makeReq(validBody));
    const orderPayload = createOrderInSession.mock.calls[0][0];
    expect(orderPayload.orderId).toMatch(/^ord_\d+_/);
    expect(orderPayload.status).toBe("completed");
  });

  it("legacy path: orderType derivation domain/hosting/bundle", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setupLegacyHappyPath();

    await POST(
      makeReq({
        ...validBody,
        cartItems: [
          {
            domainName: "ex.com",
            price: 999,
            currency: "INR",
            itemType: "domain" as const,
          },
          {
            domainName: "host-x",
            price: 1500,
            currency: "INR",
            itemType: "hosting" as const,
          },
        ],
      })
    );
    const payload = createOrderInSession.mock.calls[0][0];
    expect(payload.orderType).toBe("bundle");
  });
});

// ─── Zoho invoice ──────────────────────────────────────────────────
describe("Zoho invoice — best-effort + H1 mirror", () => {
  it("cartItemsFromOrderDomains called with order.domains (NOT request cartItems)", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    const dbDomains = [{ domainName: "real.com", price: 500 }];
    createOrderInSession.mockResolvedValueOnce({
      _id: "OID-1",
      orderId: "ORD-1",
      domains: dbDomains,
    });

    await POST(makeReq(validBody));
    expect(cartItemsFromOrderDomains).toHaveBeenCalledWith(dbDomains);
  });

  it("Zoho failure SWALLOWED — main response still 200", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setupLegacyHappyPath();
    createZohoInvoice.mockRejectedValueOnce(new Error("Zoho down"));

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200); // guest verify is NOT 207 — silent fail
    expect(forceMarkZohoCreationFailed).toHaveBeenCalledWith("OID-1");
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "guest/verify",
        service: "payments",
      })
    );
  });
});

// ─── Setup-password email ──────────────────────────────────────────
describe("Setup-password email — new guests only", () => {
  it("new guest (isGuest:true) → sendPasswordResetEmail called with 4th arg true (setup mode)", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setupLegacyHappyPath();

    await POST(makeReq(validBody));

    expect(sendPasswordResetEmail).toHaveBeenCalled();
    const args = sendPasswordResetEmail.mock.calls[0];
    expect(args[3]).toBe(true); // setup=true
  });

  it("resetToken set + resetTokenExpiry +24h", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const newGuest = {
      _id: "U_NEW",
      email: "guest@x.com",
      firstName: "First",
      lastName: "Last",
      isGuest: true,
      save,
    };
    createUser.mockResolvedValueOnce(newGuest);
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setupLegacyHappyPath();

    await POST(makeReq(validBody));
    expect((newGuest as any).resetToken).toMatch(/^[a-f0-9]{64}$/);
    expect((newGuest as any).resetTokenExpiry).toBeInstanceOf(Date);
    expect(save).toHaveBeenCalled();
  });

  it("NON-guest user (isGuest:false or undefined) → NO setup email", async () => {
    const existingNonGuest = {
      _id: "U-REAL",
      email: "guest@x.com",
      isGuest: false,
    };
    // Won't reach here because email-claim defense fires first — pin the
    // path where the user starts as guest:false but somehow passes. Use a
    // user with isGuest = undefined post-backfill instead.
    getUserByEmail.mockResolvedValueOnce({
      ...existingNonGuest,
      isGuest: undefined as any,
    });
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(409); // email-claim defense path
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });
});

// ─── Post-payment tasks ────────────────────────────────────────────
describe("runPostPaymentTasks", () => {
  it("called after Zoho with orderStatus:'completed'", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    setupLegacyHappyPath();

    await POST(makeReq(validBody));
    expect(runPostPaymentTasks).toHaveBeenCalledWith(
      expect.objectContaining({ orderStatus: "completed" })
    );
  });
});

// ─── Catch path: fallback Order ────────────────────────────────────
describe("Catch path — fallback Order for post-signature failures", () => {
  it("provisioning throw → fallback createOrder with status:'processing'", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    provisionCartItems.mockRejectedValueOnce(new Error("Provisioner died"));
    getOrderByOrderId.mockResolvedValueOnce(null); // not yet persisted

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Payment verification failed");

    expect(createOrder).toHaveBeenCalled();
    const payload = createOrder.mock.calls[0][0];
    expect(payload.status).toBe("processing");
    expect(payload.domains[0].error).toMatch(/contact support/);
    expect(payload.paymentVerification.paymentStatus).toBe(
      "captured_pending_support"
    );
  });

  it("dedup: getOrderByOrderId returns row → skip fallback createOrder (anti-duplicate-key)", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    provisionCartItems.mockRejectedValueOnce(new Error("Provisioner died"));
    getOrderByOrderId.mockResolvedValueOnce({
      orderId: "ord_existing",
      status: "completed",
    });

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(500);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("no orderId / no cartItems → NO fallback createOrder (insufficient context)", async () => {
    // Force throw BEFORE orderId is set (in the rate-limit / token path
    // there's no orderId yet)
    rlIsAllowed.mockRejectedValueOnce(new Error("Redis down"));
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(500);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("fallback derives orderType correctly: hosting+domain → 'bundle'", async () => {
    getOrderByRazorpayOrderId.mockResolvedValueOnce(null);
    provisionCartItems.mockRejectedValueOnce(new Error("Provisioner died"));
    getOrderByOrderId.mockResolvedValueOnce(null);

    await POST(
      makeReq({
        ...validBody,
        cartItems: [
          {
            domainName: "ex.com",
            price: 999,
            currency: "INR",
            itemType: "domain" as const,
          },
          {
            domainName: "host-x",
            price: 1500,
            currency: "INR",
            itemType: "hosting" as const,
          },
        ],
      })
    );
    expect(createOrder.mock.calls[0][0].orderType).toBe("bundle");
  });
});
