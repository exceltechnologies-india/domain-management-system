/**
 * Tests for `app/api/payments/guest/create-order/route.ts` (rescan-4
 * slice 7g0). Pre-payment gate for guest checkout. Two modes:
 *  - **With guestToken**: signed token is source of truth; body's
 *    registrant fields ignored (anti-tampering between consent and
 *    verify — token is the consent record)
 *  - **Without token**: deep per-field validation, sign a fresh token
 *
 * Pins:
 *  - **Rate-limit FIRST** (5/min IP cap on unauthenticated path)
 *  - **Existing token**: invalid → 401; valid → registrant details
 *    extracted from token (NOT body)
 *  - **Fresh-token validation**:
 *    - missing email → 400 'Email is required'
 *    - InputValidator.validateEmail invalid → 400 'Invalid email'
 *    - missing any of 7 required fields → 400 'Missing required
 *      field: <name>'
 *    - phone !== 10 digits → 400
 *    - zipcode !== 6 digits → 400
 *    - firstName/lastName length > 50 → 400
 *  - **Trial-block**: cartItems.isTrial → 400 (mirrors verify)
 *  - **TLD policy check** validateDomainPeriod fires only on domain
 *    items (not hosting)
 *  - **Disposable-email block** isDisposableEmail → 400 with code:
 *    'DISPOSABLE_EMAIL' (anti-throwaway-account; trial-abuse IP/
 *    device throttle NOT reused here — paid checkout is its own
 *    friction)
 *  - **Live price verification**: priceCheck.ok=false → 409
 *    'PRICE_CHANGED' (same as logged-in)
 *  - **Total amount**: priceCheck.serverTotal + hostingTotal (hosting
 *    items trusted as-is — they use HostingPlan DB, NOT RC); fellBack
 *    → use client total
 *  - **totalAmount <= 0** → 400 'Invalid order amount'
 *  - **Email-claim defense**: existing NON-guest user → 409 'sign in
 *    to continue' (last fence — funded attacker could otherwise plant
 *    Order/Hosting/Domain rows under any known email)
 *  - **Existing guest user reuse**: NOT rejected (repeat abandoned
 *    checkout reuse is fine)
 *  - **createUser for new guest**: random 64-hex password, isGuest:
 *    true, profileCompleted:true, provider:'credentials'
 *  - **createOrder pending row** persisted BEFORE response; status:
 *    'pending', razorpayPaymentId/Signature='pending' placeholders;
 *    DB write failure → 500 'Failed to initialise order'
 *  - **derivedOrderType**: domain+hosting → 'bundle', hosting →
 *    'hosting', domain → 'domain'
 *  - **Token reuse**: existing token reused verbatim in response;
 *    fresh token signed when none provided
 *  - **Response shape**: razorpayOrderId, amount, currency, guestToken,
 *    email
 *  - **Outer catch**: 500 'Failed to create payment order'
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const signGuestToken = vi.hoisted(() => vi.fn());
const verifyGuestToken = vi.hoisted(() => vi.fn());
vi.mock("@/lib/guest-token", () => ({
  signGuestToken,
  verifyGuestToken,
}));

const validateEmail = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => { isValid: boolean; errors: string[] }>(
    () => ({ isValid: true, errors: [] })
  )
);
vi.mock("@/lib/validation", () => ({
  InputValidator: { validateEmail },
}));

const validateDomainPeriod = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => string | null>(() => null)
);
vi.mock("@/lib/tld-policies", () => ({ validateDomainPeriod }));

const verifyDomainPrices = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/payment/price-verifier", () => ({
  verifyDomainPrices,
}));

const isDisposableEmail = vi.hoisted(() => vi.fn(() => false));
vi.mock("@/lib/disposable-emails", () => ({ isDisposableEmail }));

const getClientIp = vi.hoisted(() => vi.fn(() => "1.2.3.4"));
const hashIp = vi.hoisted(() => vi.fn((ip: string) => `hash:${ip}`));
vi.mock("@/lib/trial-abuse", () => ({ getClientIp, hashIp }));

const createOrder = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({ createOrder }));

const createUser = vi.hoisted(() => vi.fn());
const getUserByEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ createUser, getUserByEmail }));

const createRazorpayOrder = vi.hoisted(() => vi.fn());
vi.mock("@/lib/razorpay", () => ({
  RazorpayService: { createOrder: createRazorpayOrder },
}));

const rlIsAllowed = vi.hoisted(() => vi.fn());
const rateLimitResponse = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rate-limit", () => ({
  rateLimiters: { guestCheckout: { isAllowed: rlIsAllowed } },
  rateLimitResponse,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/payments/guest/create-order/route";

function makeReq(body: unknown) {
  return new NextRequest("https://example.com/api/payments/guest/create-order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validRegistrant = {
  firstName: "First",
  lastName: "Last",
  phone: "9876543210",
  addressLine1: "1 Main St",
  city: "City",
  state: "State",
  zipcode: "400001",
};

const validBody = {
  email: "guest@x.com",
  cartItems: [
    {
      domainName: "ex.com",
      price: 999,
      currency: "INR",
      registrationPeriod: 1,
      itemType: "domain",
    },
  ],
  ...validRegistrant,
};

beforeEach(() => {
  rlIsAllowed.mockReset().mockResolvedValue({ allowed: true });
  rateLimitResponse.mockReset();
  signGuestToken.mockReset().mockReturnValue("signed_tok_X");
  verifyGuestToken.mockReset();
  validateEmail.mockReset().mockReturnValue({ isValid: true, errors: [] });
  validateDomainPeriod.mockReset().mockReturnValue(null);
  verifyDomainPrices
    .mockReset()
    .mockResolvedValue({ ok: true, serverTotal: 999 });
  isDisposableEmail.mockReset().mockReturnValue(false);
  createOrder.mockReset().mockResolvedValue(undefined);
  createUser.mockReset().mockResolvedValue({
    _id: "U_NEW",
    email: "guest@x.com",
    firstName: "First",
    lastName: "Last",
    isGuest: true,
  });
  getUserByEmail.mockReset().mockResolvedValue(null);
  createRazorpayOrder
    .mockReset()
    .mockResolvedValue({ id: "order_RP_X", amount: 99900 });
  getClientIp.mockReset().mockReturnValue("1.2.3.4");
});

// ─── Rate-limit ────────────────────────────────────────────────────
describe("Rate-limit gate — FIRST", () => {
  it("not allowed → rateLimitResponse (NO downstream)", async () => {
    const rlResp = NextResponse.json(
      { error: "Too many" },
      { status: 429 }
    );
    rlIsAllowed.mockResolvedValueOnce({ allowed: false });
    rateLimitResponse.mockReturnValueOnce(rlResp);
    const res = await POST(makeReq(validBody));
    expect(res).toBe(rlResp);
    expect(verifyDomainPrices).not.toHaveBeenCalled();
  });

  it("limit 5 + descriptive message", async () => {
    rlIsAllowed.mockResolvedValueOnce({ allowed: false });
    rateLimitResponse.mockReturnValueOnce(
      NextResponse.json({}, { status: 429 })
    );
    await POST(makeReq(validBody));
    const opts = rateLimitResponse.mock.calls[0][1];
    expect(opts.limit).toBe(5);
    expect(opts.message).toMatch(/Too many checkout attempts/);
  });
});

// ─── Existing-token mode ──────────────────────────────────────────
describe("Existing-token mode", () => {
  it("invalid token → 401 'Guest session expired'", async () => {
    verifyGuestToken.mockReturnValueOnce(null);
    const res = await POST(
      makeReq({ ...validBody, guestToken: "bad_tok" })
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/Guest session expired/);
  });

  it("valid token → registrant from TOKEN (NOT body — anti-tampering)", async () => {
    verifyGuestToken.mockReturnValueOnce({
      email: "token@x.com",
      firstName: "TokenFirst",
      lastName: "TokenLast",
      phone: "1112223333",
      addressLine1: "Token Addr",
      city: "TokenCity",
      state: "TokenState",
      zipcode: "111111",
    });

    await POST(
      makeReq({
        ...validBody,
        guestToken: "tok_X",
        // body firstName etc are different from token — should be IGNORED
        firstName: "BodyFirst",
      })
    );

    const userPayload = createUser.mock.calls[0]?.[0];
    expect(userPayload.email).toBe("token@x.com");
    expect(userPayload.firstName).toBe("TokenFirst");
    expect(userPayload.phone).toBe("1112223333");
  });

  it("valid token → existingToken REUSED verbatim in response (NOT re-signed)", async () => {
    verifyGuestToken.mockReturnValueOnce({
      email: "token@x.com",
      ...validRegistrant,
    });

    const res = await POST(
      makeReq({ ...validBody, guestToken: "existing_tok_X" })
    );
    const body = await res.json();
    expect(body.guestToken).toBe("existing_tok_X");
    expect(signGuestToken).not.toHaveBeenCalled();
  });
});

// ─── Fresh-token validation ────────────────────────────────────────
describe("Fresh-token mode — per-field validation", () => {
  it("missing email → 400 'Email is required'", async () => {
    const res = await POST(
      makeReq({ ...validBody, email: undefined })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Email is required");
  });

  it("validateEmail invalid → 400 'Invalid email address'", async () => {
    validateEmail.mockReturnValueOnce({ isValid: false, errors: ["bad"] });
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid email address");
  });

  it("email normalized to lowercase + trimmed BEFORE validation", async () => {
    await POST(makeReq({ ...validBody, email: "  GUEST@X.COM  " }));
    expect(validateEmail).toHaveBeenCalledWith("guest@x.com");
  });

  it.each([
    "firstName",
    "lastName",
    "phone",
    "addressLine1",
    "city",
    "state",
    "zipcode",
  ])("missing %s → 400 'Missing required field'", async (field) => {
    const res = await POST(makeReq({ ...validBody, [field]: undefined }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(`Missing required field: ${field}`);
  });

  it("phone not 10 digits → 400", async () => {
    const res = await POST(makeReq({ ...validBody, phone: "98765" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/10-digit/);
  });

  it("zipcode not 6 digits → 400", async () => {
    const res = await POST(makeReq({ ...validBody, zipcode: "1234" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/6-digit/);
  });

  it("firstName > 50 chars → 400", async () => {
    const res = await POST(
      makeReq({ ...validBody, firstName: "x".repeat(51) })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/too long/);
  });

  it("lastName > 50 chars → 400", async () => {
    const res = await POST(
      makeReq({ ...validBody, lastName: "x".repeat(51) })
    );
    expect(res.status).toBe(400);
  });

  it("**fresh token signed and returned in response**", async () => {
    const res = await POST(makeReq(validBody));
    expect(signGuestToken).toHaveBeenCalled();
    const body = await res.json();
    expect(body.guestToken).toBe("signed_tok_X");
  });
});

// ─── Cart validation ───────────────────────────────────────────────
describe("Cart validation", () => {
  it("empty cartItems → schema rejection (Zod-level)", async () => {
    const res = await POST(makeReq({ ...validBody, cartItems: [] }));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("trial item → 400 'Free trials require an account'", async () => {
    const res = await POST(
      makeReq({
        ...validBody,
        cartItems: [
          {
            domainName: "host-x",
            price: 0,
            currency: "INR",
            registrationPeriod: 15,
            itemType: "hosting",
            isTrial: true,
          },
        ],
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Free trials require an account/);
  });

  it("TLD policy validateDomainPeriod fires ONLY on domain items", async () => {
    await POST(
      makeReq({
        ...validBody,
        cartItems: [
          {
            domainName: "host-x",
            price: 1500,
            currency: "INR",
            registrationPeriod: 12,
            itemType: "hosting",
          },
        ],
      })
    );
    expect(validateDomainPeriod).not.toHaveBeenCalled();
  });

  it("TLD policy error → 400 with policy message", async () => {
    validateDomainPeriod.mockReturnValueOnce(
      "shop.ai requires a minimum registration of 2 years."
    );
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(
      "shop.ai requires a minimum registration of 2 years."
    );
  });
});

// ─── Disposable-email block ────────────────────────────────────────
describe("Disposable-email block", () => {
  it("isDisposableEmail → 400 'DISPOSABLE_EMAIL' code", async () => {
    isDisposableEmail.mockReturnValueOnce(true);
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("DISPOSABLE_EMAIL");
    expect(body.error).toMatch(/Disposable email/);
  });

  it("disposable check fires AFTER cart validation, BEFORE price verification", async () => {
    isDisposableEmail.mockReturnValueOnce(true);
    await POST(makeReq(validBody));
    expect(isDisposableEmail).toHaveBeenCalledWith("guest@x.com");
    expect(verifyDomainPrices).not.toHaveBeenCalled();
  });
});

// ─── Live price verification ───────────────────────────────────────
describe("Live price verification", () => {
  it("price mismatch → 409 PRICE_CHANGED with serverTotal/clientTotal/mismatchedDomains", async () => {
    verifyDomainPrices.mockResolvedValueOnce({
      ok: false,
      error: "Price changed",
      serverTotal: 1200,
      clientTotal: 999,
      mismatchedDomains: ["ex.com"],
    });
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("PRICE_CHANGED");
    expect(body.serverTotal).toBe(1200);
    expect(body.clientTotal).toBe(999);
  });

  it("fellBackToClient → proceeds, uses client total", async () => {
    verifyDomainPrices.mockResolvedValueOnce({
      ok: true,
      fellBackToClient: true,
      clientTotal: 999,
    });
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
    expect(createRazorpayOrder).toHaveBeenCalledWith(
      999,
      "INR",
      expect.any(String)
    );
  });

  it("hostingTotal added on top of serverTotal (hosting NOT in RC pricing)", async () => {
    verifyDomainPrices.mockResolvedValueOnce({
      ok: true,
      serverTotal: 999,
    });
    await POST(
      makeReq({
        ...validBody,
        cartItems: [
          {
            domainName: "ex.com",
            price: 999,
            currency: "INR",
            registrationPeriod: 1,
            itemType: "domain" as const,
          },
          {
            domainName: "host-x",
            price: 1500,
            currency: "INR",
            registrationPeriod: 12,
            itemType: "hosting" as const,
          },
        ],
      })
    );
    // serverTotal(999) + hostingTotal(1500*12=18000) = 18999
    expect(createRazorpayOrder).toHaveBeenCalledWith(
      18999,
      "INR",
      expect.any(String)
    );
  });

  it("totalAmount <= 0 → 400 'Invalid order amount'", async () => {
    verifyDomainPrices.mockResolvedValueOnce({
      ok: true,
      serverTotal: 0,
    });
    const res = await POST(
      makeReq({
        ...validBody,
        cartItems: [
          {
            domainName: "ex.com",
            price: 0,
            currency: "INR",
            registrationPeriod: 1,
            itemType: "domain" as const,
          },
        ],
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid order amount");
  });
});

// ─── Razorpay order create ────────────────────────────────────────
describe("Razorpay order create", () => {
  it("receipt id starts with 'gst_'", async () => {
    await POST(makeReq(validBody));
    expect(createRazorpayOrder).toHaveBeenCalledWith(
      999,
      "INR",
      expect.stringMatching(/^gst_\d+_[a-z0-9]+$/)
    );
  });
});

// ─── Email-claim defense ───────────────────────────────────────────
describe("Email-claim defense", () => {
  it("existing NON-guest user → 409 'sign in to continue'", async () => {
    getUserByEmail.mockResolvedValueOnce({
      _id: "U-REAL",
      email: "guest@x.com",
      isGuest: false,
    });
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/sign in to continue/);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("existing GUEST user reused (NOT rejected — repeat checkout is fine)", async () => {
    getUserByEmail.mockResolvedValueOnce({
      _id: "U-OLD",
      email: "guest@x.com",
      isGuest: true,
      firstName: "First",
      lastName: "Last",
    });
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
    expect(createUser).not.toHaveBeenCalled(); // reused, not recreated
  });
});

// ─── createUser for new guest ─────────────────────────────────────
describe("createUser for new guest", () => {
  it("isGuest:true, profileCompleted:true, provider:'credentials', country:'IN', phoneCc:'+91'", async () => {
    await POST(makeReq(validBody));
    const payload = createUser.mock.calls[0][0];
    expect(payload.isGuest).toBe(true);
    expect(payload.profileCompleted).toBe(true);
    expect(payload.provider).toBe("credentials");
    expect(payload.address.country).toBe("IN");
    expect(payload.phoneCc).toBe("+91");
  });

  it("random 64-hex unusable password", async () => {
    await POST(makeReq(validBody));
    expect(createUser.mock.calls[0][0].password).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ─── createOrder pending row ──────────────────────────────────────
describe("createOrder pending-row persistence", () => {
  it("status:'pending' + razorpayPaymentId/Signature='pending' placeholders", async () => {
    await POST(makeReq(validBody));
    const payload = createOrder.mock.calls[0][0];
    expect(payload.status).toBe("pending");
    expect(payload.razorpayPaymentId).toBe("pending");
    expect(payload.razorpaySignature).toBe("pending");
    expect(payload.razorpayOrderId).toBe("order_RP_X");
  });

  it("orderId starts with 'ord_'", async () => {
    await POST(makeReq(validBody));
    expect(createOrder.mock.calls[0][0].orderId).toMatch(
      /^ord_\d+_[a-z0-9]+$/
    );
  });

  it("DB write failure → 500 'Failed to initialise order'", async () => {
    createOrder.mockRejectedValueOnce(new Error("DB outage"));
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/Failed to initialise order/);
  });

  it("derivedOrderType: domain-only → 'domain'", async () => {
    await POST(makeReq(validBody));
    expect(createOrder.mock.calls[0][0].orderType).toBe("domain");
  });

  it("derivedOrderType: hosting-only → 'hosting'", async () => {
    verifyDomainPrices.mockResolvedValueOnce({ ok: true, serverTotal: 0 });
    await POST(
      makeReq({
        ...validBody,
        cartItems: [
          {
            domainName: "host-x",
            linkedDomain: "hostsite.com",
            price: 1500,
            currency: "INR",
            registrationPeriod: 12,
            itemType: "hosting" as const,
          },
        ],
      })
    );
    expect(createOrder.mock.calls[0][0].orderType).toBe("hosting");
  });

  it("derivedOrderType: domain + hosting → 'bundle'", async () => {
    await POST(
      makeReq({
        ...validBody,
        cartItems: [
          {
            domainName: "ex.com",
            price: 999,
            currency: "INR",
            registrationPeriod: 1,
            itemType: "domain" as const,
          },
          {
            domainName: "host-x",
            price: 1500,
            currency: "INR",
            registrationPeriod: 12,
            itemType: "hosting" as const,
          },
        ],
      })
    );
    expect(createOrder.mock.calls[0][0].orderType).toBe("bundle");
  });

  it("bookingStatus[0] = 'payment_verified' placeholder, progress 5", async () => {
    await POST(makeReq(validBody));
    const domains = createOrder.mock.calls[0][0].domains;
    expect(domains[0].bookingStatus[0].step).toBe("payment_verified");
    expect(domains[0].bookingStatus[0].progress).toBe(5);
  });

  it("periodUnit defaults: domain → 'years', hosting → 'months'", async () => {
    await POST(
      makeReq({
        ...validBody,
        cartItems: [
          {
            domainName: "ex.com",
            price: 999,
            currency: "INR",
            registrationPeriod: 1,
            itemType: "domain" as const,
          },
          {
            domainName: "host-x",
            price: 1500,
            currency: "INR",
            registrationPeriod: 12,
            itemType: "hosting" as const,
          },
        ],
      })
    );
    const domains = createOrder.mock.calls[0][0].domains;
    expect(domains[0].periodUnit).toBe("years");
    expect(domains[1].periodUnit).toBe("months");
  });

  it("userId on pending Order = guest user._id", async () => {
    await POST(makeReq(validBody));
    expect(createOrder.mock.calls[0][0].userId).toBe("U_NEW");
  });
});

// ─── Response shape ────────────────────────────────────────────────
describe("Response shape", () => {
  it("happy path: razorpayOrderId + amount + currency + guestToken + email", async () => {
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.razorpayOrderId).toBe("order_RP_X");
    expect(body.amount).toBe(999);
    expect(body.currency).toBe("INR");
    expect(body.email).toBe("guest@x.com");
    expect(body.guestToken).toBe("signed_tok_X");
  });
});

// ─── Outer catch ───────────────────────────────────────────────────
describe("Outer catch — 500 fallback", () => {
  it("RazorpayService.createOrder throw → 500 'Failed to create payment order'", async () => {
    createRazorpayOrder.mockRejectedValueOnce(new Error("RP down"));
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to create payment order");
  });
});
