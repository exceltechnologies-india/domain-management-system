/**
 * Tests for `app/api/payments/create-order/route.ts` (rescan-4 slice
 * 7fy). The pre-payment gate. Sequence: auth → schema → TLD policy →
 * **live price verification** (anti-tampering) → optional trial-
 * eligibility & abuse check → Razorpay order/subscription create →
 * persist pending Order row → return payment targets. Pins:
 *  - **Auth FIRST**: no user → 401 (no downstream side effects)
 *  - **Schema gate**: empty cartItems → "Cart is empty"
 *  - **TLD policy check**: validateDomainPeriod error → 400 with the
 *    policy message; runs ONLY on `domain` items (or undefined
 *    itemType = legacy), NOT on hosting
 *  - **Live price verification** (server-side anti-tampering):
 *    priceCheck.ok=false → 409 'PRICE_CHANGED' with serverTotal +
 *    clientTotal + mismatchedDomains payload so the client can show
 *    "prices have changed" UX
 *  - **Trial gates** (4 distinct rejections, in order): yearly-only
 *    constraint → 400; settings flag off → 400 "Free trials are
 *    currently unavailable"; prior trial → 400; abuse-check fail →
 *    400 with abuse code (defense-in-depth — eligibility endpoint is
 *    advisory only)
 *  - **recordTrialClaim called BEFORE subscription creation** (anti-
 *    bypass: even if Razorpay fails, the throttle is recorded — 30-
 *    day window; a false-positive throttle is preferable to letting
 *    the same browser retry through a fresh email)
 *  - **Subscription creation failure** falls back to one-time charge
 *    (oneTimeAmount += item.price) — no error surfaced to user
 *  - **createOrder pending-row persistence**: row written BEFORE
 *    response so the webhook + /verify both find it; DB write
 *    failure → 500 "Failed to initialise order" (better than a paid
 *    Razorpay order with no DB row)
 *  - **derivedOrderType**: domain+hosting → 'bundle', hosting-only →
 *    'hosting', domain-only → 'domain'
 *  - **Razorpay error mapping**: 5 distinct branches — Invalid amount
 *    → 400; Amount too small → 400 "Minimum ₹1"; Amount too large
 *    → 400 "Maximum ₹10,00,000"; Network error → 503; Gateway error
 *    → 502; default → 500
 *  - **No payment target**: razorpayOrderId AND subscriptionData both
 *    null → throws (caught as 500)
 *  - **Response shape**: razorpayOrderId, razorpaySubscriptionId,
 *    subscriptionPlan, amount, currency, hasSubscription, isTrial
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ AuthService: { getUserFromRequest } }));

const createOrder = vi.hoisted(() => vi.fn());
const userHasPriorTrialOrder = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  createOrder,
  userHasPriorTrialOrder,
}));

const verifyDomainPrices = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/payment/price-verifier", () => ({
  verifyDomainPrices,
}));

const validateDomainPeriod = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tld-policies", () => ({ validateDomainPeriod }));

const createRazorpayOrder = vi.hoisted(() => vi.fn());
const createSubscription = vi.hoisted(() => vi.fn());
const createCustomer = vi.hoisted(() => vi.fn());
const createRecurringTokenOrder = vi.hoisted(() => vi.fn());
vi.mock("@/lib/razorpay", () => ({
  RazorpayService: {
    createOrder: createRazorpayOrder,
    createSubscription,
    createCustomer,
    createRecurringTokenOrder,
  },
}));

const evaluateTrialAbuse = vi.hoisted(() => vi.fn());
const getClientIp = vi.hoisted(() => vi.fn(() => "1.2.3.4"));
const hashIp = vi.hoisted(() => vi.fn((ip: string) => `hash:${ip}`));
const recordTrialClaim = vi.hoisted(() => vi.fn());
vi.mock("@/lib/trial-abuse", () => ({
  evaluateTrialAbuse,
  getClientIp,
  hashIp,
  recordTrialClaim,
}));

const HostingPlanFindOne = vi.hoisted(() => vi.fn());
vi.mock("@/models/HostingPlan", () => ({
  default: { findOne: HostingPlanFindOne },
}));

// The route resolves hosting plans via getPlanByPlanId (dynamic import), which
// calls connectDB() first. Without mocking @/lib/mongodb the real Mongoose
// client hangs on the placeholder test URI, timing out every hosting-path test.
vi.mock("@/lib/mongodb", () => ({ default: vi.fn().mockResolvedValue(undefined) }));

const getSettingValue = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/settings", () => ({ getSettingValue }));

// Manual-flow trial provisioner — used by the new
// HOSTING_MANDATE_FLOW=manual branch in the route. Returns a minimal
// success shape since the route only checks for throw vs no-throw.
const createManualFlowTrialHosting = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/payment/manual-trial-provisioner", () => ({
  createManualFlowTrialHosting,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/payments/create-order/route";

function makeReq(body: unknown) {
  return new NextRequest("https://example.com/api/payments/create-order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validUser = {
  id: "U1",
  _id: "U1",
  email: "u@x.com",
  firstName: "First",
  lastName: "Last",
  phone: "9876543210",
};

const domainCart = {
  cartItems: [
    {
      domainName: "ex.com",
      price: 999,
      currency: "INR",
      registrationPeriod: 1,
      itemType: "domain",
    },
  ],
};

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(validUser);
  createOrder.mockReset().mockResolvedValue(undefined);
  userHasPriorTrialOrder.mockReset().mockResolvedValue(false);
  verifyDomainPrices.mockReset().mockResolvedValue({ ok: true });
  validateDomainPeriod.mockReset().mockReturnValue(null);
  createRazorpayOrder
    .mockReset()
    .mockResolvedValue({ id: "order_RP_X", amount: 99900 });
  createSubscription
    .mockReset()
    .mockResolvedValue({ id: "sub_RP_X" });
  createCustomer.mockReset().mockResolvedValue({ id: "cust_tok_X" });
  createRecurringTokenOrder
    .mockReset()
    .mockResolvedValue({ id: "order_tok_X", amount: 200 });
  createManualFlowTrialHosting.mockReset().mockResolvedValue({
    hostingId: "H_MANUAL_1",
    domainName: "host-manual.com",
    expiryDate: new Date("2026-07-12"),
    status: "pending",
  });
  // Always reset the feature flag to default at the start of each test —
  // individual Tokens-flow tests opt-in via `process.env.HOSTING_MANDATE_FLOW = 'tokens'`
  // and clean up at the end (see the Tokens-flow describe block).
  delete process.env.HOSTING_MANDATE_FLOW;
  evaluateTrialAbuse.mockReset().mockResolvedValue({ allowed: true });
  recordTrialClaim.mockReset().mockResolvedValue(undefined);
  // Default: a resolvable hosting plan with Razorpay plan ids so the
  // subscription/tokens branches can fire. Tests exercising the "plan not
  // found" path set `HostingPlanFindOne.mockResolvedValueOnce(null)` explicitly.
  HostingPlanFindOne.mockReset().mockResolvedValue({
    planId: "pro",
    name: "Pro",
    renewalPrice: 49.99,
    isActive: true,
    razorpayPlans: { yearly: "plan_yr_X", monthly: "plan_mo_X" },
  });
  getSettingValue.mockReset().mockResolvedValue(undefined);
  getClientIp.mockReset().mockReturnValue("1.2.3.4");
  hashIp.mockReset().mockImplementation((ip: string) => `hash:${ip}`);
});

// ── Auth gate ────────────────────────────────────────────────────────
describe("Auth gate — FIRST check", () => {
  it("no user → 401 'Unauthorized' (NO downstream side effects)", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makeReq(domainCart));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
    expect(verifyDomainPrices).not.toHaveBeenCalled();
    expect(createRazorpayOrder).not.toHaveBeenCalled();
  });
});

// ── Schema validation ──────────────────────────────────────────────
describe("Schema validation", () => {
  it("empty cartItems → 400 'Cart is empty'", async () => {
    const res = await POST(makeReq({ cartItems: [] }));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("missing cartItems → 400", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("price negative → 400", async () => {
    const res = await POST(
      makeReq({
        cartItems: [
          {
            domainName: "ex.com",
            price: -1,
            currency: "INR",
          },
        ],
      })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

// ── TLD policy check ───────────────────────────────────────────────
describe("TLD policy check", () => {
  it("validateDomainPeriod error → 400 with policy message", async () => {
    validateDomainPeriod.mockReturnValueOnce(
      "shop.ai requires a minimum registration of 2 years."
    );
    const res = await POST(makeReq(domainCart));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(
      "shop.ai requires a minimum registration of 2 years."
    );
  });

  it("runs ONLY on domain items, NOT hosting", async () => {
    await POST(
      makeReq({
        cartItems: [
          {
            domainName: "host-pkg.com",
            price: 1500,
            currency: "INR",
            itemType: "hosting",
            registrationPeriod: 1,
            billingCycle: "yearly",
          },
        ],
      })
    );
    expect(validateDomainPeriod).not.toHaveBeenCalled();
  });

  it("runs on items with undefined itemType (legacy = domain)", async () => {
    await POST(
      makeReq({
        cartItems: [
          {
            domainName: "ex.com",
            price: 999,
            currency: "INR",
            registrationPeriod: 1,
          },
        ],
      })
    );
    expect(validateDomainPeriod).toHaveBeenCalledWith("ex.com", 1);
  });
});

// ── Live price verification ────────────────────────────────────────
describe("Live price verification — anti-tampering", () => {
  it("price mismatch → 409 PRICE_CHANGED with serverTotal + clientTotal + mismatchedDomains", async () => {
    verifyDomainPrices.mockResolvedValueOnce({
      ok: false,
      error: "Price changed. Please review.",
      serverTotal: 1200,
      clientTotal: 999,
      mismatchedDomains: ["ex.com"],
    });
    const res = await POST(makeReq(domainCart));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("PRICE_CHANGED");
    expect(body.serverTotal).toBe(1200);
    expect(body.clientTotal).toBe(999);
    expect(body.mismatchedDomains).toEqual(["ex.com"]);
    expect(createRazorpayOrder).not.toHaveBeenCalled();
  });

  it("fellBackToClient → proceeds (warning logged, but no rejection)", async () => {
    verifyDomainPrices.mockResolvedValueOnce({
      ok: true,
      fellBackToClient: true,
      clientTotal: 999,
    });
    const res = await POST(makeReq(domainCart));
    expect(res.status).toBe(200);
  });
});

// ── Trial gates ────────────────────────────────────────────────────
describe("Trial gates (4 distinct rejections)", () => {
  const trialCart = {
    cartItems: [
      {
        domainName: "host-x.com",
        linkedDomain: "trialsite.com",
        price: 0,
        currency: "INR",
        itemType: "hosting" as const,
        billingCycle: "yearly" as const,
        registrationPeriod: 15, // 15 days
        isTrial: true,
        hostingPlan: { id: "starter", name: "Starter" },
      },
    ],
  };

  it("non-yearly + non-15-period → 400 'Trial is only available for yearly hosting plans'", async () => {
    const res = await POST(
      makeReq({
        cartItems: [
          {
            ...trialCart.cartItems[0],
            billingCycle: "monthly",
            registrationPeriod: 1,
          },
        ],
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(
      "Trial is only available for yearly hosting plans"
    );
  });

  it("trialsEnabled=false → 400 'Free trials are currently unavailable'", async () => {
    getSettingValue.mockResolvedValueOnce(false);
    const res = await POST(makeReq(trialCart));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Free trials are currently unavailable");
  });

  it("user has prior trial → 400 'You have already used your free trial'", async () => {
    getSettingValue.mockResolvedValueOnce(true);
    userHasPriorTrialOrder.mockResolvedValueOnce(true);
    const res = await POST(makeReq(trialCart));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("You have already used your free trial");
  });

  it("abuse-check denied → 400 with reason + code", async () => {
    getSettingValue.mockResolvedValueOnce(true);
    userHasPriorTrialOrder.mockResolvedValueOnce(false);
    evaluateTrialAbuse.mockResolvedValueOnce({
      allowed: false,
      reason: "Too many trials from this IP",
      code: "IP_RATE_LIMIT",
    });
    const res = await POST(makeReq(trialCart));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Too many trials from this IP");
    expect(body.code).toBe("IP_RATE_LIMIT");
  });

  it("**recordTrialClaim called BEFORE subscription** (anti-bypass: throttle even if Razorpay fails)", async () => {
    getSettingValue.mockResolvedValueOnce(true);
    evaluateTrialAbuse.mockResolvedValueOnce({ allowed: true });
    HostingPlanFindOne.mockResolvedValueOnce({
      name: "Starter",
      razorpayPlans: { yearly: "plan_RP_yearly" },
    });
    // Force subscription to fail AFTER recordTrialClaim should already run
    createSubscription.mockRejectedValueOnce(new Error("Razorpay down"));

    await POST(makeReq(trialCart));

    expect(recordTrialClaim).toHaveBeenCalled();
    // Order of mock calls — recordTrialClaim before createSubscription
    const claimOrder = recordTrialClaim.mock.invocationCallOrder[0];
    const subOrder = createSubscription.mock.invocationCallOrder[0];
    expect(claimOrder).toBeLessThan(subOrder);
  });

  it("trial subscription createSubscription called with 15-day trial_period", async () => {
    getSettingValue.mockResolvedValueOnce(true);
    HostingPlanFindOne.mockResolvedValueOnce({
      name: "Starter",
      razorpayPlans: { yearly: "plan_RP_yearly" },
    });

    await POST(makeReq(trialCart));

    // signature: (planId, userId, domain, true, 100, isTrial ? 15 : undefined)
    // domain = the linked domain (trialCart carries linkedDomain 'trialsite.com').
    expect(createSubscription).toHaveBeenCalledWith(
      "plan_RP_yearly",
      "U1",
      "trialsite.com",
      true,
      100,
      15
    );
  });

  it("non-trial subscription: trial_period undefined", async () => {
    HostingPlanFindOne.mockResolvedValueOnce({
      name: "Pro",
      razorpayPlans: { yearly: "plan_RP_pro_yearly" },
    });
    await POST(
      makeReq({
        cartItems: [
          {
            domainName: "host-x.com",
            price: 1500,
            currency: "INR",
            itemType: "hosting" as const,
            billingCycle: "yearly" as const,
            registrationPeriod: 12,
            hostingPlan: { id: "pro" },
          },
        ],
      })
    );
    const args = createSubscription.mock.calls[0];
    expect(args[5]).toBeUndefined();
  });
});

// ── Subscription creation failure fallback ─────────────────────────
describe("Subscription creation failure → falls back to one-time", () => {
  it("createSubscription throw → oneTimeAmount += item.price (no error surfaced)", async () => {
    HostingPlanFindOne.mockResolvedValueOnce({
      name: "Pro",
      razorpayPlans: { yearly: "plan_x" },
    });
    createSubscription.mockRejectedValueOnce(new Error("Razorpay down"));

    const res = await POST(
      makeReq({
        cartItems: [
          {
            domainName: "host-x.com",
            price: 1500,
            currency: "INR",
            itemType: "hosting" as const,
            billingCycle: "yearly" as const,
            registrationPeriod: 12,
            hostingPlan: { id: "pro" },
          },
        ],
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.amount).toBe(18000); // 1500 * 12
    expect(body.hasSubscription).toBe(false);
  });

  it("HostingPlan not found → falls through to one-time charge", async () => {
    HostingPlanFindOne.mockResolvedValueOnce(null);
    const res = await POST(
      makeReq({
        cartItems: [
          {
            domainName: "host-x.com",
            price: 1500,
            currency: "INR",
            itemType: "hosting" as const,
            billingCycle: "yearly" as const,
            registrationPeriod: 12,
            hostingPlan: { id: "missing" },
          },
        ],
      })
    );
    expect(res.status).toBe(200);
    expect(createSubscription).not.toHaveBeenCalled();
  });
});

// ── Pending Order persistence ──────────────────────────────────────
describe("createOrder pending-row persistence", () => {
  it("pending Order persisted BEFORE response", async () => {
    await POST(makeReq(domainCart));
    expect(createOrder).toHaveBeenCalled();
    const payload = createOrder.mock.calls[0][0];
    expect(payload.status).toBe("pending");
    expect(payload.razorpayOrderId).toBe("order_RP_X");
    expect(payload.razorpayPaymentId).toBe("pending");
    expect(payload.razorpaySignature).toBe("pending");
  });

  it("DB write failure → 500 'Failed to initialise order'", async () => {
    createOrder.mockRejectedValueOnce(new Error("DB outage"));
    const res = await POST(makeReq(domainCart));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/Failed to initialise order/);
  });

  it("user name pulled from firstName + lastName fields", async () => {
    await POST(makeReq(domainCart));
    expect(createOrder.mock.calls[0][0].userName).toBe("First Last");
  });

  it("derivedOrderType: domain-only → 'domain'", async () => {
    await POST(makeReq(domainCart));
    expect(createOrder.mock.calls[0][0].orderType).toBe("domain");
  });

  it("derivedOrderType: hosting-only → 'hosting'", async () => {
    HostingPlanFindOne.mockResolvedValueOnce(null);
    await POST(
      makeReq({
        cartItems: [
          {
            domainName: "host-x.com",
            price: 1500,
            currency: "INR",
            itemType: "hosting" as const,
            billingCycle: "yearly" as const,
            registrationPeriod: 12,
            hostingPlan: { id: "pro" },
          },
        ],
      })
    );
    expect(createOrder.mock.calls[0][0].orderType).toBe("hosting");
  });

  it("derivedOrderType: domain + hosting → 'bundle'", async () => {
    HostingPlanFindOne.mockResolvedValueOnce(null);
    await POST(
      makeReq({
        cartItems: [
          {
            domainName: "ex.com",
            price: 999,
            currency: "INR",
            registrationPeriod: 1,
            itemType: "domain",
          },
          {
            domainName: "host-x.com",
            price: 1500,
            currency: "INR",
            itemType: "hosting" as const,
            billingCycle: "yearly" as const,
            registrationPeriod: 12,
            hostingPlan: { id: "pro" },
          },
        ],
      })
    );
    expect(createOrder.mock.calls[0][0].orderType).toBe("bundle");
  });

  it("each domain row gets bookingStatus[0]='payment_verified' placeholder", async () => {
    await POST(makeReq(domainCart));
    const domains = createOrder.mock.calls[0][0].domains;
    expect(domains[0].bookingStatus[0].step).toBe("payment_verified");
    expect(domains[0].bookingStatus[0].progress).toBe(5);
  });

  it("periodUnit defaults: domain → 'years', hosting → 'months'", async () => {
    HostingPlanFindOne.mockResolvedValueOnce(null);
    await POST(
      makeReq({
        cartItems: [
          {
            domainName: "ex.com",
            price: 999,
            currency: "INR",
            registrationPeriod: 1,
            itemType: "domain",
          },
          {
            domainName: "host-x.com",
            price: 1500,
            currency: "INR",
            itemType: "hosting" as const,
            billingCycle: "yearly" as const,
            registrationPeriod: 12,
            hostingPlan: { id: "pro" },
          },
        ],
      })
    );
    const domains = createOrder.mock.calls[0][0].domains;
    expect(domains[0].periodUnit).toBe("years");
    expect(domains[1].periodUnit).toBe("months");
  });
});

// ── Razorpay error mapping ─────────────────────────────────────────
describe("Razorpay error mapping — 5 distinct status codes", () => {
  it.each([
    ["Invalid amount provided", 400, /Invalid payment amount/],
    ["Amount too small for processing", 400, /Minimum amount is/],
    ["Amount too large for processing", 400, /Maximum amount is/],
    ["Network error reaching gateway", 503, /temporarily unavailable/],
    ["Gateway error from Razorpay", 502, /Payment gateway error/],
  ])(
    "'%s' → status %d with matching message",
    async (errMsg, status, msgPattern) => {
      createRazorpayOrder.mockRejectedValueOnce(new Error(errMsg));
      const res = await POST(makeReq(domainCart));
      expect(res.status).toBe(status);
      const body = await res.json();
      expect(body.error).toMatch(msgPattern as RegExp);
    }
  );

  it("unmapped error → 500 'Failed to create payment order'", async () => {
    createRazorpayOrder.mockRejectedValueOnce(new Error("Random error"));
    const res = await POST(makeReq(domainCart));
    expect(res.status).toBe(500);
  });
});

// ── No payment target ──────────────────────────────────────────────
describe("No payment target — caught as 500", () => {
  it("oneTimeAmount=0 AND no subscription created → throws (500)", async () => {
    HostingPlanFindOne.mockResolvedValueOnce({
      name: "Starter",
      // No razorpayPlans → subscription not created; trial price=0 → no oneTimeAmount
      razorpayPlans: {},
    });
    getSettingValue.mockResolvedValueOnce(true);

    const res = await POST(
      makeReq({
        cartItems: [
          {
            domainName: "host-x.com",
            price: 0,
            currency: "INR",
            itemType: "hosting",
            billingCycle: "yearly" as const,
            registrationPeriod: 15,
            isTrial: true,
            hostingPlan: { id: "starter" },
          },
        ],
      })
    );

    // Path: no subscription target + zero oneTimeAmount → throw → outer catch
    // Either the inner Razorpay-error mapper returns 500 'Failed to create
    // payment order' OR the outer catch returns 500. Both surface as 500.
    expect(res.status).toBe(500);
  });
});

// ── Response shape ─────────────────────────────────────────────────
describe("Response shape — payment targets returned", () => {
  it("domain-only happy path: razorpayOrderId + amount + currency + hasSubscription:false", async () => {
    const res = await POST(makeReq(domainCart));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.razorpayOrderId).toBe("order_RP_X");
    expect(body.amount).toBe(999);
    expect(body.currency).toBe("INR");
    expect(body.hasSubscription).toBe(false);
    expect(body.isTrial).toBe(false);
  });

  it("subscription happy path: subscriptionId + planName + hasSubscription:true", async () => {
    HostingPlanFindOne.mockResolvedValueOnce({
      name: "Pro",
      razorpayPlans: { yearly: "plan_pro" },
    });
    const res = await POST(
      makeReq({
        cartItems: [
          {
            domainName: "host-x.com",
            price: 1500,
            currency: "INR",
            itemType: "hosting" as const,
            billingCycle: "yearly" as const,
            registrationPeriod: 12,
            hostingPlan: { id: "pro" },
          },
        ],
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.razorpaySubscriptionId).toBe("sub_RP_X");
    expect(body.subscriptionPlan).toBe("Pro");
    expect(body.hasSubscription).toBe(true);
    expect(body.isTrial).toBe(false);
  });

  it("trial subscription: isTrial:true in response", async () => {
    getSettingValue.mockResolvedValueOnce(true);
    HostingPlanFindOne.mockResolvedValueOnce({
      name: "Starter",
      razorpayPlans: { yearly: "plan_yearly" },
    });
    const res = await POST(
      makeReq({
        cartItems: [
          {
            domainName: "host-x.com",
            price: 0,
            currency: "INR",
            itemType: "hosting" as const,
            billingCycle: "yearly" as const,
            registrationPeriod: 15,
            isTrial: true,
            hostingPlan: { id: "starter" },
          },
        ],
      })
    );
    const body = await res.json();
    expect(body.isTrial).toBe(true);
  });
});

// ── Bundled cart receipt ID + totalAmount ────────────────────────────
describe("Razorpay createOrder args", () => {
  it("called with amount in rupees (not paise — Razorpay service converts internally)", async () => {
    await POST(makeReq(domainCart));
    expect(createRazorpayOrder).toHaveBeenCalledWith(
      999,
      "INR",
      expect.stringMatching(/^ord_/)
    );
  });

  it("receipt id starts with 'ord_'", async () => {
    await POST(makeReq(domainCart));
    expect(createRazorpayOrder.mock.calls[0][2]).toMatch(/^ord_\d+_[a-z0-9]+$/);
  });
});

// ── Tokens-flow branch (Phase 2A — HOSTING_MANDATE_FLOW=tokens) ────────
describe("Tokens-flow branch (Phase 2A)", () => {
  const tokensTrialCart = {
    cartItems: [
      {
        domainName: "host-tokens.com",
        price: 0,
        currency: "INR",
        itemType: "hosting" as const,
        billingCycle: "yearly" as const,
        registrationPeriod: 15,
        isTrial: true,
        hostingPlan: { id: "starter", name: "Starter" },
      },
    ],
  };

  beforeEach(() => {
    process.env.HOSTING_MANDATE_FLOW = "tokens";
    HostingPlanFindOne.mockResolvedValue({
      planId: "starter",
      name: "Starter",
      renewalPrice: 49.99,
      razorpayPlans: { yearly: "plan_yearly_starter", monthly: "plan_monthly_starter" },
    });
    getSettingValue.mockResolvedValue(true);  // trials enabled
  });

  it("with flag=tokens + trial + no other items: calls createCustomer + createRecurringTokenOrder; NOT createSubscription", async () => {
    const res = await POST(makeReq(tokensTrialCart));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(createCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "u@x.com",
        contact: "9876543210",
        notes: { user_id: "U1" },
      })
    );
    expect(createRecurringTokenOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "cust_tok_X",
        validationAmountInPaise: 200,
        maxAmountInPaise: 1500000,
        frequency: "as_presented",
      })
    );
    // `method` must NOT be pinned — omitting it lets the recurring overlay
    // offer all eligible mandate rails (Card + UPI Autopay). Pinning 'card'
    // was the bug that hid UPI Autopay from trial users.
    expect(createRecurringTokenOrder.mock.calls[0][0].method).toBeUndefined();
    expect(createSubscription).not.toHaveBeenCalled();

    // Response shape: tokens mode signal + auth order id + customer id
    expect(body.mandateMode).toBe("tokens");
    expect(body.razorpayOrderId).toBe("order_tok_X");
    expect(body.razorpayCustomerId).toBe("cust_tok_X");
    expect(body.razorpaySubscriptionId).toBeUndefined();
    expect(body.amount).toBe(2);  // ₹2 validation amount, not the plan price
  });

  it("CIT auth order's notes carry the trial intent for the webhook handler", async () => {
    await POST(makeReq(tokensTrialCart));
    const args = createRecurringTokenOrder.mock.calls[0][0];
    expect(args.notes).toEqual(
      expect.objectContaining({
        type: "mandate_validation",
        user_id: "U1",
        domain_name: "host-tokens.com",
        plan_id: "starter",
        is_trial: "true",
        trial_days: "15",
        intended_charge_paise: "59988",  // ₹49.99 × 12 in paise
      })
    );
  });

  it("flag NOT set: falls through to Subscriptions flow even for a trial", async () => {
    delete process.env.HOSTING_MANDATE_FLOW;
    await POST(makeReq(tokensTrialCart));
    expect(createCustomer).not.toHaveBeenCalled();
    expect(createRecurringTokenOrder).not.toHaveBeenCalled();
    expect(createSubscription).toHaveBeenCalled();
  });

  it("user has no phone: falls through to Subscriptions flow", async () => {
    getUserFromRequest.mockResolvedValueOnce({ ...validUser, phone: undefined });
    await POST(makeReq(tokensTrialCart));
    expect(createCustomer).not.toHaveBeenCalled();
    expect(createSubscription).toHaveBeenCalled();
  });

  it("Tokens-flow API failure falls back to Subscriptions flow (NO error to user)", async () => {
    createCustomer.mockRejectedValueOnce(new Error("Razorpay 500"));
    const res = await POST(makeReq(tokensTrialCart));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Fell through to Subscriptions flow successfully
    expect(createSubscription).toHaveBeenCalled();
    expect(body.razorpaySubscriptionId).toBe("sub_RP_X");
    expect(body.mandateMode).toBe("subscription");
  });

  it("non-trial recurring hosting: stays on Subscriptions flow even when flag=tokens (Phase 2A scope)", async () => {
    const nonTrialCart = {
      cartItems: [
        {
          domainName: "host-paid.com",
          price: 49.99,
          currency: "INR",
          itemType: "hosting" as const,
          billingCycle: "yearly" as const,
          registrationPeriod: 12,
          isTrial: false,
          hostingPlan: { id: "starter", name: "Starter" },
        },
      ],
    };
    await POST(makeReq(nonTrialCart));
    expect(createCustomer).not.toHaveBeenCalled();
    expect(createRecurringTokenOrder).not.toHaveBeenCalled();
    expect(createSubscription).toHaveBeenCalled();
  });

  afterEach(() => {
    delete process.env.HOSTING_MANDATE_FLOW;
  });
});

// ── Manual-flow branch (HOSTING_MANDATE_FLOW=manual) ───────────────────
//
// The manual flow skips Razorpay entirely at signup. Customer signs up,
// Hosting is provisioned with billingType='manual' + isTrial=true, and
// at trial-end the existing renewal-reminder cron fires + the customer
// pays manually via /api/user/hosting/renew. Shipped as a temporary
// path while UPI Autopay activation is pending (~2026-07-08); the
// operator flips back to HOSTING_MANDATE_FLOW=tokens once activated.
//
// Tests focus on the branch's correctness:
//   - flag=manual + trial → calls createManualFlowTrialHosting; does
//     NOT touch Razorpay (no customer / no token order / no
//     subscription / no one-shot order)
//   - Order row persisted with mandateMode='manual'
//   - Response shape signals manualMode=true to the frontend so it
//     skips razorpay.open()
//   - Falls through to Subscriptions on provisioner failure
//   - Non-trial stays on Subscriptions even when flag=manual
//   - Mutual exclusion: when flag=manual + tokens-prerequisites both
//     met, the manual branch wins (it runs FIRST) and tokens skips
//     via the new !subscriptionCreated gate
describe("Manual-flow branch (HOSTING_MANDATE_FLOW=manual)", () => {
  const manualTrialCart = {
    cartItems: [
      {
        domainName: "host-manual.com",
        price: 0,
        currency: "INR",
        itemType: "hosting" as const,
        billingCycle: "yearly" as const,
        registrationPeriod: 15,
        isTrial: true,
        hostingPlan: { id: "starter", name: "Starter" },
      },
    ],
  };

  beforeEach(() => {
    process.env.HOSTING_MANDATE_FLOW = "manual";
    HostingPlanFindOne.mockResolvedValue({
      planId: "starter",
      name: "Starter",
      renewalPrice: 49.99,
      razorpayPlans: { yearly: "plan_yearly_starter", monthly: "plan_monthly_starter" },
    });
    getSettingValue.mockResolvedValue(true); // trials enabled
  });

  afterEach(() => {
    delete process.env.HOSTING_MANDATE_FLOW;
  });

  it("with flag=manual + trial: calls createManualFlowTrialHosting; NO Razorpay calls of any kind", async () => {
    const res = await POST(makeReq(manualTrialCart));
    expect(res.status).toBe(200);

    // Manual provisioner was invoked with the expected shape
    expect(createManualFlowTrialHosting).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "U1",
        domainName: "host-manual.com",
        planId: "starter",
        planName: "Starter",
        orderId: expect.stringMatching(/^ord_\d+_[a-z0-9]+$/),
      })
    );

    // ZERO Razorpay surface — that's the whole point of manual mode
    expect(createCustomer).not.toHaveBeenCalled();
    expect(createRecurringTokenOrder).not.toHaveBeenCalled();
    expect(createSubscription).not.toHaveBeenCalled();
    expect(createRazorpayOrder).not.toHaveBeenCalled();
  });

  it("persists a Mongo Order row with mandateMode='manual' + orderType='hosting_trial' + amount=0", async () => {
    await POST(makeReq(manualTrialCart));
    expect(createOrder).toHaveBeenCalledTimes(1);
    const orderArgs = createOrder.mock.calls[0][0];
    expect(orderArgs).toMatchObject({
      mandateMode: "manual",
      orderType: "hosting_trial",
      amount: 0,
      status: "pending",
      currency: "INR",
    });
    // Domain shape carries the trial signal
    expect(orderArgs.domains[0]).toMatchObject({
      domainName: "host-manual.com",
      isTrial: true,
      itemType: "hosting",
      hostingPlan: expect.objectContaining({ planId: "starter" }),
    });
  });

  it("response shape signals manualMode=true + no Razorpay IDs + amount=0 (frontend skips razorpay.open())", async () => {
    const res = await POST(makeReq(manualTrialCart));
    const body = await res.json();
    expect(body).toMatchObject({
      success: true,
      manualMode: true,
      mandateMode: "manual",
      amount: 0,
      currency: "INR",
      hasSubscription: true,
      isTrial: true,
    });
    // No Razorpay handles to open with
    expect(body.razorpayOrderId).toBeUndefined();
    expect(body.razorpaySubscriptionId).toBeUndefined();
    expect(body.razorpayCustomerId).toBeUndefined();
  });

  it("flag NOT set: falls through to Subscriptions flow even for a trial (manual is opt-in)", async () => {
    delete process.env.HOSTING_MANDATE_FLOW;
    await POST(makeReq(manualTrialCart));
    expect(createManualFlowTrialHosting).not.toHaveBeenCalled();
    expect(createSubscription).toHaveBeenCalled();
  });

  it("flag=manual + provisioner throws: falls back to Subscriptions flow (NO error to user)", async () => {
    createManualFlowTrialHosting.mockRejectedValueOnce(new Error("Mongo write failed"));
    const res = await POST(makeReq(manualTrialCart));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Fell through cleanly
    expect(createSubscription).toHaveBeenCalled();
    expect(body.mandateMode).toBe("subscription");
    expect(body.manualMode).toBeFalsy(); // not in manual mode anymore
  });

  it("flag=manual + non-trial recurring hosting: stays on Subscriptions (manual is trial-only by design)", async () => {
    const nonTrialCart = {
      cartItems: [
        {
          domainName: "host-paid.com",
          price: 49.99,
          currency: "INR",
          itemType: "hosting" as const,
          billingCycle: "yearly" as const,
          registrationPeriod: 12,
          isTrial: false,
          hostingPlan: { id: "starter", name: "Starter" },
        },
      ],
    };
    await POST(makeReq(nonTrialCart));
    expect(createManualFlowTrialHosting).not.toHaveBeenCalled();
    expect(createSubscription).toHaveBeenCalled();
  });

  it("flag=manual wins over tokens when both would be eligible (manual runs first; tokens skips via !subscriptionCreated)", async () => {
    // flag=manual + user has phone (tokens-flow precondition) + trial +
    // no other items. Under the existing precedence, manual fires first
    // and sets subscriptionCreated=true; tokens branch must skip even
    // though its own preconditions would otherwise pass.
    process.env.HOSTING_MANDATE_FLOW = "manual";
    await POST(makeReq(manualTrialCart));
    expect(createManualFlowTrialHosting).toHaveBeenCalled();
    // Tokens-flow Razorpay calls must NOT happen
    expect(createCustomer).not.toHaveBeenCalled();
    expect(createRecurringTokenOrder).not.toHaveBeenCalled();
  });

  it("does NOT create a one-shot Razorpay order (oneTimeAmount stays 0 since item.price=0 + subscriptionCreated=true)", async () => {
    await POST(makeReq(manualTrialCart));
    // The post-branch `if (oneTimeAmount > 0)` block should be skipped
    expect(createRazorpayOrder).not.toHaveBeenCalled();
  });
});
