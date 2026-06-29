/**
 * Tests for `app/api/user/hosting/trial-eligibility/route.ts`
 * (slice 7hs, part 2).
 *
 * Customer-facing 5-layer trial-eligibility check. Drives the "Try
 * free for 15 days" CTA on the hosting plans page.
 *
 * Threat model:
 *  - **Trial-farming via repeat registrations**: an attacker with
 *    multiple email addresses on the same IP / device tries to claim
 *    multiple free trials. Pinned: `userHasPriorTrialOrder` AND
 *    `evaluateTrialAbuse` (IP+device throttle) both must pass.
 *  - **Eligibility check shape divergence between GET and POST**:
 *    older clients still hit GET; newer ones hit POST with abuse
 *    signals in the body (not the URL/referer). The shared
 *    `runEligibility` ensures both paths are identical past the
 *    schema/QS layer. Pinned via direct symmetry tests.
 *
 * Other pins:
 *  - Auth gate → 401
 *  - hosting_trial_enabled === false → eligible:false "Trials are
 *    currently unavailable"
 *  - userHasPriorTrialOrder true → eligible:false "already used"
 *  - evaluateTrialAbuse.allowed=false → eligible:false with code
 *    + reason from abuse helper
 *  - planId supplied + plan missing yearly Razorpay → eligible:false
 *  - happy path → eligible:true, trialDays:15, otpRequired from setting
 *  - POST schema accepts the 4 optional fields; bad body → 400
 *  - GET pulls planId from ?planId query
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const userHasPriorTrialOrder = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({ userHasPriorTrialOrder }));

const getPlanByPlanId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hosting-plans", () => ({ getPlanByPlanId }));

const getSettingValue = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/settings", () => ({ getSettingValue }));

const evaluateTrialAbuse = vi.hoisted(() => vi.fn());
const getClientIp = vi.hoisted(() => vi.fn());
const hashIp = vi.hoisted(() => vi.fn());
const isTrialOtpRequired = vi.hoisted(() => vi.fn());
vi.mock("@/lib/trial-abuse", () => ({
  evaluateTrialAbuse,
  getClientIp,
  hashIp,
  isTrialOtpRequired,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET, POST } from "@/app/api/user/hosting/trial-eligibility/route";

function makeGet(qs = "") {
  const url = qs
    ? `https://example.com/api/user/hosting/trial-eligibility?${qs}`
    : "https://example.com/api/user/hosting/trial-eligibility";
  return new NextRequest(url, { method: "GET" });
}

function makePost(body: unknown = {}) {
  return new NextRequest(
    "https://example.com/api/user/hosting/trial-eligibility",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

function setupHappy() {
  getUserFromRequest.mockResolvedValue({
    _id: "U1",
    email: "alice@example.com",
    phone: "9999999999",
  });
  getSettingValue.mockResolvedValue(true); // trials enabled
  userHasPriorTrialOrder.mockResolvedValue(false);
  getClientIp.mockReturnValue("203.0.113.1");
  hashIp.mockReturnValue("hashed_ip");
  evaluateTrialAbuse.mockResolvedValue({ allowed: true });
  isTrialOtpRequired.mockResolvedValue(false);
}

beforeEach(() => {
  getUserFromRequest.mockReset();
  userHasPriorTrialOrder.mockReset();
  getPlanByPlanId.mockReset();
  getSettingValue.mockReset();
  evaluateTrialAbuse.mockReset();
  getClientIp.mockReset();
  hashIp.mockReset();
  isTrialOtpRequired.mockReset();
});

describe("Auth gate", () => {
  it("POST: no user → 401 UNAUTHORIZED; no downstream check", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makePost());
    expect(res.status).toBe(401);
    expect(getSettingValue).not.toHaveBeenCalled();
    expect(userHasPriorTrialOrder).not.toHaveBeenCalled();
  });

  it("GET: no user → 401", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeGet());
    expect(res.status).toBe(401);
  });
});

describe("Layer 1 — global trials kill-switch", () => {
  it("hosting_trial_enabled === false → eligible:false with kill-switch message", async () => {
    setupHappy();
    getSettingValue.mockResolvedValueOnce(false);
    const res = await POST(makePost());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.eligible).toBe(false);
    expect(body.reason).toBe("Trials are currently unavailable");
    expect(userHasPriorTrialOrder).not.toHaveBeenCalled();
  });

  it("setting missing (undefined) → default-true (eligible if other layers pass)", async () => {
    setupHappy();
    getSettingValue.mockResolvedValueOnce(undefined);
    const res = await POST(makePost());
    const body = await res.json();
    expect(body.eligible).toBe(true);
  });
});

describe("Layer 2 — one trial per user lifetime", () => {
  it("prior trial exists → eligible:false 'already used'", async () => {
    setupHappy();
    userHasPriorTrialOrder.mockResolvedValueOnce(true);
    const res = await POST(makePost());
    const body = await res.json();
    expect(body.eligible).toBe(false);
    expect(body.reason).toContain("already used");
    expect(evaluateTrialAbuse).not.toHaveBeenCalled();
  });

  it("userHasPriorTrialOrder called with the resolved user._id (not body/query)", async () => {
    setupHappy();
    await POST(makePost({ userId: "U_HOSTILE_OVERRIDE" }));
    expect(userHasPriorTrialOrder).toHaveBeenCalledWith("U1");
  });
});

describe("Layer 3 — anti-abuse defenses", () => {
  it("evaluateTrialAbuse.allowed=false → eligible:false with code+reason from helper", async () => {
    setupHappy();
    evaluateTrialAbuse.mockResolvedValueOnce({
      allowed: false,
      code: "DISPOSABLE_EMAIL",
      reason: "Disposable email addresses aren't eligible for trials",
    });
    const res = await POST(makePost());
    const body = await res.json();
    expect(body.eligible).toBe(false);
    expect(body.code).toBe("DISPOSABLE_EMAIL");
    expect(body.reason).toContain("Disposable");
    // Plan check downstream NOT reached
    expect(getPlanByPlanId).not.toHaveBeenCalled();
  });

  it("abuse signals (deviceFingerprint, otpToken) passed through to evaluator", async () => {
    setupHappy();
    await POST(
      makePost({
        deviceFingerprint: "fp-abc",
        otpToken: "otp-tok",
      })
    );
    const [signals, opts] = evaluateTrialAbuse.mock.calls[0];
    expect(signals).toEqual(
      expect.objectContaining({
        email: "alice@example.com",
        ipHash: "hashed_ip",
        deviceFingerprint: "fp-abc",
        phone: "9999999999",
        otpToken: "otp-tok",
      })
    );
    expect(opts).toEqual(
      expect.objectContaining({
        clientIp: "203.0.113.1",
      })
    );
  });
});

describe("Layer 4 — planId yearly-Razorpay-mapping", () => {
  // The Razorpay-plans-yearly check is mode-gated: it only fires under
  // HOSTING_MANDATE_FLOW=subscriptions (the default). Tokens and Manual
  // flows don't need pre-configured Razorpay plans. The default-flow
  // tests in this block assume HOSTING_MANDATE_FLOW is unset (treated
  // as 'subscriptions'). The mode-specific tests at the end pin the
  // 2026-06-29 incident-fix behavior across all three modes.
  beforeEach(() => {
    delete process.env.HOSTING_MANDATE_FLOW;
  });

  it("plan missing → eligible:false 'plan is not available for a free trial'", async () => {
    setupHappy();
    getPlanByPlanId.mockResolvedValueOnce(null);
    const res = await POST(makePost({ planId: "p-ghost" }));
    const body = await res.json();
    expect(body.eligible).toBe(false);
    expect(body.reason).toContain("not available");
  });

  it("plan exists BUT razorpayPlans.yearly missing (under subscriptions flow) → eligible:false", async () => {
    setupHappy();
    getPlanByPlanId.mockResolvedValueOnce({
      planId: "p-1",
      razorpayPlans: { monthly: "rzp-monthly" /* no yearly */ },
    });
    const res = await POST(makePost({ planId: "p-1" }));
    const body = await res.json();
    expect(body.eligible).toBe(false);
  });

  it("plan with yearly Razorpay → eligible:true (when other layers pass)", async () => {
    setupHappy();
    getPlanByPlanId.mockResolvedValueOnce({
      planId: "p-1",
      razorpayPlans: { yearly: "rzp-yearly" },
    });
    const res = await POST(makePost({ planId: "p-1" }));
    const body = await res.json();
    expect(body.eligible).toBe(true);
  });

  it("no planId supplied → plan check SKIPPED; eligible:true on happy path", async () => {
    setupHappy();
    const res = await POST(makePost());
    const body = await res.json();
    expect(body.eligible).toBe(true);
    expect(getPlanByPlanId).not.toHaveBeenCalled();
  });

  // 2026-06-29 incident-fix tests. After the operator flipped
  // HOSTING_MANDATE_FLOW=manual to launch the no-mandate trial path,
  // every customer hitting "Start Free Trial" got "This plan is not
  // available for a free trial" because the Razorpay-yearly gate was
  // checking a field that only matters under subscriptions flow. The
  // fix mode-gates the Razorpay-plans check.
  it("HOSTING_MANDATE_FLOW=manual + plan WITHOUT razorpayPlans.yearly → eligible:true (no Razorpay involvement under manual)", async () => {
    process.env.HOSTING_MANDATE_FLOW = "manual";
    setupHappy();
    getPlanByPlanId.mockResolvedValueOnce({
      planId: "starter",
      // No razorpayPlans.yearly — Manual flow doesn't need it
      razorpayPlans: {},
    });
    const res = await POST(makePost({ planId: "starter" }));
    const body = await res.json();
    expect(body.eligible).toBe(true);
  });

  it("HOSTING_MANDATE_FLOW=tokens + plan WITHOUT razorpayPlans.yearly → eligible:true (Tokens uses CIT auth, no pre-configured plan)", async () => {
    process.env.HOSTING_MANDATE_FLOW = "tokens";
    setupHappy();
    getPlanByPlanId.mockResolvedValueOnce({
      planId: "starter",
      razorpayPlans: {},
    });
    const res = await POST(makePost({ planId: "starter" }));
    const body = await res.json();
    expect(body.eligible).toBe(true);
  });

  it("HOSTING_MANDATE_FLOW=manual + plan MISSING ENTIRELY → still eligible:false (the plan-exists check is mode-independent)", async () => {
    process.env.HOSTING_MANDATE_FLOW = "manual";
    setupHappy();
    getPlanByPlanId.mockResolvedValueOnce(null);
    const res = await POST(makePost({ planId: "p-ghost" }));
    const body = await res.json();
    expect(body.eligible).toBe(false);
    expect(body.reason).toContain("not available");
  });
});

describe("Layer 5 — OTP-required flag", () => {
  it("isTrialOtpRequired=true → response carries otpRequired:true", async () => {
    setupHappy();
    isTrialOtpRequired.mockResolvedValueOnce(true);
    const res = await POST(makePost());
    const body = await res.json();
    expect(body.otpRequired).toBe(true);
  });

  it("isTrialOtpRequired=false → otpRequired:false", async () => {
    setupHappy();
    const res = await POST(makePost());
    const body = await res.json();
    expect(body.otpRequired).toBe(false);
  });
});

describe("Happy path response shape", () => {
  it("eligible:true with trialDays:15 + otpRequired", async () => {
    setupHappy();
    const res = await POST(makePost());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      eligible: true,
      trialDays: 15,
      otpRequired: false,
    });
  });
});

describe("GET ↔ POST symmetry (shared runEligibility)", () => {
  it("GET with ?planId triggers the same yearly-mapping check as POST", async () => {
    setupHappy();
    getPlanByPlanId.mockResolvedValue(null); // both calls
    const resGet = await GET(makeGet("planId=p-1"));
    const resPost = await POST(makePost({ planId: "p-1" }));
    const bGet = await resGet.json();
    const bPost = await resPost.json();
    expect(bGet.eligible).toBe(false);
    expect(bPost.eligible).toBe(false);
    expect(bGet.reason).toEqual(bPost.reason);
  });
});

describe("POST schema", () => {
  it("bogus type (planId: 123) → 400", async () => {
    setupHappy();
    const res = await POST(makePost({ planId: 123 }));
    expect(res.status).toBe(400);
    expect(getSettingValue).not.toHaveBeenCalled();
  });
});

describe("Outer catch", () => {
  it("evaluateTrialAbuse throw → 500 generic", async () => {
    setupHappy();
    evaluateTrialAbuse.mockRejectedValueOnce(
      new Error("abuse-service down — abuse_secret_LEAK_ME")
    );
    const res = await POST(makePost());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toContain("abuse_secret_LEAK_ME");
  });
});
