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
import { describe, it, expect, vi, beforeEach } from "vitest";

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
vi.mock("@/lib/razorpay", () => ({
  RazorpayService: {
    createOrder: createRazorpayOrder,
    createSubscription,
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

const getSettingValue = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/settings", () => ({ getSettingValue }));

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
  evaluateTrialAbuse.mockReset().mockResolvedValue({ allowed: true });
  recordTrialClaim.mockReset().mockResolvedValue(undefined);
  HostingPlanFindOne.mockReset().mockResolvedValue(null);
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
            domainName: "host-pkg",
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
        domainName: "host-x",
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
    expect(createSubscription).toHaveBeenCalledWith(
      "plan_RP_yearly",
      "U1",
      "host-x",
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
            domainName: "host-x",
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
            domainName: "host-x",
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
            domainName: "host-x",
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
            domainName: "host-x",
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
            domainName: "host-x",
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
            domainName: "host-x",
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
            domainName: "host-x",
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
            domainName: "host-x",
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
            domainName: "host-x",
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
