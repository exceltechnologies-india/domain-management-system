/**
 * Tests for `app/api/admin/hosting/test-plan/route.ts` (slice 7hv, part 2).
 *
 * Admin toggle for the public "₹1 test plan" CTA. Used by the team
 * to live-verify a Razorpay payment end-to-end (the test plan is
 * never sold — it's a live-ish probe of the payment path).
 *
 * Threat model:
 *  - **Test-plan accidentally left on**: if `enable` partially-fails
 *    (Razorpay creates the plan but our DB write throws), the public
 *    page would show a ₹1 plan while admin thinks it's off. Pinned:
 *    RC creation comes BEFORE the feature-flag setting, so a failure
 *    halts WITHOUT flipping the flag.
 *  - **Strict-boolean default-false on the feature flag**: a missing
 *    setting must default to disabled (closed-by-default for a
 *    public-facing payment surface). Pinned with `=== true`.
 *
 * Other pins:
 *  - Admin gate per-method (both GET and POST → 401)
 *  - GET response shape: { enabled:boolean, plan:null|object }
 *  - POST zod: action enum 'enable'|'disable'; razorpayPlanMonthly
 *    optional+trimmed
 *  - Disable: setPlanActive(false) + upsertSetting(false)
 *  - Enable with supplied razorpayPlanMonthly → no auto-create
 *  - Enable without supplied ID: DB fallback (existing plan's
 *    razorpayPlans.monthly) → if still empty, Razorpay createPlan
 *  - Razorpay createPlan throw → 500 RAZORPAY_ERROR; NO plan write,
 *    NO flag flip
 *  - upsertPlanByPlanId called with the locked field set
 *    (isTestPlan:true, isActive:true, directAdminPackage='Starter',
 *    price:1, currency:'INR')
 *  - adminName fallback to 'admin' when first+last name absent
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const getSettingValue = vi.hoisted(() => vi.fn());
const upsertSetting = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/settings", () => ({
  getSettingValue,
  upsertSetting,
}));

const createPlan = vi.hoisted(() => vi.fn());
vi.mock("@/lib/razorpay", () => ({
  RazorpayService: { createPlan },
}));

const getPlanByPlanIdLean = vi.hoisted(() => vi.fn());
const setPlanActive = vi.hoisted(() => vi.fn());
const upsertPlanByPlanId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hosting-plans", () => ({
  getPlanByPlanIdLean,
  setPlanActive,
  upsertPlanByPlanId,
}));

vi.mock("@/lib/mongodb", () => ({
  default: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET, POST } from "@/app/api/admin/hosting/test-plan/route";

function makeReq(method: "GET" | "POST", body?: unknown) {
  return new NextRequest(
    "https://example.com/api/admin/hosting/test-plan",
    {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }
  );
}

beforeEach(() => {
  getAdminFromRequest.mockReset().mockResolvedValue({
    _id: "ADMIN1",
    firstName: "Alice",
    lastName: "Admin",
  });
  getSettingValue.mockReset();
  upsertSetting.mockReset().mockResolvedValue(undefined);
  createPlan.mockReset();
  getPlanByPlanIdLean.mockReset();
  setPlanActive.mockReset().mockResolvedValue(undefined);
  upsertPlanByPlanId.mockReset();
});

// ─────────────────────────── GET ─────────────────────────────

describe("GET — admin gate", () => {
  it("non-admin → 401; no read", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(401);
    expect(getPlanByPlanIdLean).not.toHaveBeenCalled();
  });
});

describe("GET — strict-boolean default-false (closed-by-default)", () => {
  it("setting === true → enabled:true", async () => {
    getPlanByPlanIdLean.mockResolvedValueOnce({ planId: "test_1rs" });
    getSettingValue.mockResolvedValueOnce(true);
    const res = await GET(makeReq("GET"));
    const body = await res.json();
    expect(body.enabled).toBe(true);
  });

  it("setting === false → enabled:false", async () => {
    getPlanByPlanIdLean.mockResolvedValueOnce(null);
    getSettingValue.mockResolvedValueOnce(false);
    const res = await GET(makeReq("GET"));
    const body = await res.json();
    expect(body.enabled).toBe(false);
  });

  it("setting missing/undefined → enabled:false (closed-by-default)", async () => {
    getPlanByPlanIdLean.mockResolvedValueOnce(null);
    getSettingValue.mockResolvedValueOnce(undefined);
    const res = await GET(makeReq("GET"));
    const body = await res.json();
    expect(body.enabled).toBe(false);
  });

  it("setting any non-true truthy → enabled:false (strict ===)", async () => {
    getPlanByPlanIdLean.mockResolvedValueOnce(null);
    // strict: enabled === true; "true" string would be falsey here
    getSettingValue.mockResolvedValueOnce("true" as unknown as boolean);
    const res = await GET(makeReq("GET"));
    const body = await res.json();
    expect(body.enabled).toBe(false);
  });
});

describe("GET — response shape", () => {
  it("plan null → returns plan:null (not undefined)", async () => {
    getPlanByPlanIdLean.mockResolvedValueOnce(null);
    getSettingValue.mockResolvedValueOnce(false);
    const res = await GET(makeReq("GET"));
    const body = await res.json();
    expect(body.plan).toBeNull();
  });

  it("plan exists → returned as-is", async () => {
    const plan = { planId: "test_1rs", price: 1 };
    getPlanByPlanIdLean.mockResolvedValueOnce(plan);
    getSettingValue.mockResolvedValueOnce(true);
    const res = await GET(makeReq("GET"));
    const body = await res.json();
    expect(body.plan).toEqual(plan);
  });
});

// ─────────────────────────── POST disable ─────────────────────────────

describe("POST disable", () => {
  it("non-admin → 401; no DB write", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makeReq("POST", { action: "disable" }));
    expect(res.status).toBe(401);
    expect(setPlanActive).not.toHaveBeenCalled();
    expect(upsertSetting).not.toHaveBeenCalled();
  });

  it("disable → setPlanActive(test_1rs, false) + upsertSetting(false) + 200", async () => {
    const res = await POST(makeReq("POST", { action: "disable" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, enabled: false });
    expect(setPlanActive).toHaveBeenCalledWith("test_1rs", false);
    expect(upsertSetting).toHaveBeenCalledWith(
      "hosting_test_plan_enabled",
      false,
      expect.objectContaining({
        category: "promotions",
        updatedBy: "Alice Admin",
      })
    );
    // No Razorpay call on disable
    expect(createPlan).not.toHaveBeenCalled();
    expect(upsertPlanByPlanId).not.toHaveBeenCalled();
  });
});

// ─────────────────────────── POST enable ─────────────────────────────

describe("POST enable — Razorpay plan resolution", () => {
  it("supplied razorpayPlanMonthly → used verbatim; NO Razorpay createPlan; NO DB fallback", async () => {
    upsertPlanByPlanId.mockResolvedValueOnce({ planId: "test_1rs" });
    const res = await POST(
      makeReq("POST", {
        action: "enable",
        razorpayPlanMonthly: "rzp_supplied_id",
      })
    );
    expect(res.status).toBe(200);
    expect(createPlan).not.toHaveBeenCalled();
    expect(getPlanByPlanIdLean).not.toHaveBeenCalled();
    const upsertArg = upsertPlanByPlanId.mock.calls[0][1];
    expect(upsertArg["razorpayPlans.monthly"]).toBe("rzp_supplied_id");
  });

  it("no supplied ID, DB fallback hits → used; NO Razorpay createPlan", async () => {
    getPlanByPlanIdLean.mockResolvedValueOnce({
      razorpayPlans: { monthly: "rzp_db_fallback_id" },
    });
    upsertPlanByPlanId.mockResolvedValueOnce({ planId: "test_1rs" });
    const res = await POST(makeReq("POST", { action: "enable" }));
    expect(res.status).toBe(200);
    expect(createPlan).not.toHaveBeenCalled();
    const upsertArg = upsertPlanByPlanId.mock.calls[0][1];
    expect(upsertArg["razorpayPlans.monthly"]).toBe("rzp_db_fallback_id");
  });

  it("no supplied + no DB → Razorpay.createPlan called with locked args ('₹1 Test Hosting Plan', desc, 1, 'monthly')", async () => {
    getPlanByPlanIdLean.mockResolvedValueOnce(null);
    createPlan.mockResolvedValueOnce({ id: "rzp_auto_created" });
    upsertPlanByPlanId.mockResolvedValueOnce({ planId: "test_1rs" });
    const res = await POST(makeReq("POST", { action: "enable" }));
    expect(res.status).toBe(200);
    expect(createPlan).toHaveBeenCalledWith(
      "₹1 Test Hosting Plan",
      "1-rupee live payment test plan",
      1,
      "monthly"
    );
    const upsertArg = upsertPlanByPlanId.mock.calls[0][1];
    expect(upsertArg["razorpayPlans.monthly"]).toBe("rzp_auto_created");
  });

  it("Razorpay createPlan THROW → 500 RAZORPAY_ERROR; NO plan write, NO flag flip", async () => {
    getPlanByPlanIdLean.mockResolvedValueOnce(null);
    createPlan.mockRejectedValueOnce(
      new Error("Razorpay 5xx — rzp_secret_LEAK_ME")
    );
    const res = await POST(makeReq("POST", { action: "enable" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("RAZORPAY_ERROR");
    // Critical: no partial state — neither DB plan nor flag flipped
    expect(upsertPlanByPlanId).not.toHaveBeenCalled();
    expect(upsertSetting).not.toHaveBeenCalled();
  });
});

describe("POST enable — plan upsert shape", () => {
  it("upsertPlanByPlanId called with isTestPlan:true + isActive:true + price/currency/DA-package locked", async () => {
    upsertPlanByPlanId.mockResolvedValueOnce({ planId: "test_1rs" });
    await POST(
      makeReq("POST", {
        action: "enable",
        razorpayPlanMonthly: "rzp_x",
      })
    );
    expect(upsertPlanByPlanId).toHaveBeenCalledWith(
      "test_1rs",
      expect.objectContaining({
        name: "₹1 Test Plan",
        price: 1,
        currency: "INR",
        directAdminPackage: "Starter",
        isActive: true,
        isTestPlan: true,
      })
    );
  });

  it("ordering: upsertPlanByPlanId completes BEFORE the feature-flag setting is flipped on", async () => {
    const order: string[] = [];
    upsertPlanByPlanId.mockImplementation(async () => {
      order.push("plan");
      return { planId: "test_1rs" };
    });
    upsertSetting.mockImplementation(async () => {
      order.push("flag");
    });
    await POST(
      makeReq("POST", {
        action: "enable",
        razorpayPlanMonthly: "rzp_x",
      })
    );
    expect(order).toEqual(["plan", "flag"]);
  });

  it("response carries success+enabled+plan+razorpayPlanMonthly", async () => {
    const plan = { planId: "test_1rs", name: "₹1 Test Plan" };
    upsertPlanByPlanId.mockResolvedValueOnce(plan);
    const res = await POST(
      makeReq("POST", {
        action: "enable",
        razorpayPlanMonthly: "rzp_x",
      })
    );
    const body = await res.json();
    expect(body).toEqual(
      expect.objectContaining({
        success: true,
        enabled: true,
        plan,
        razorpayPlanMonthly: "rzp_x",
      })
    );
  });
});

describe("POST — adminName fallback (QUIRK)", () => {
  it("QUIRK: admin without firstName/lastName → updatedBy='undefined undefined' (template-literal coerces, fallback never fires)", async () => {
    // The route uses `${admin.firstName} ${admin.lastName}`.trim() || "admin".
    // But the template literal coerces `undefined` to the LITERAL string
    // "undefined", so the result is "undefined undefined" — truthy after
    // .trim(), so the || "admin" fallback never fires.
    // Pin the actual behaviour; a future hardening pass with
    // `[firstName, lastName].filter(Boolean).join(" ")` would flip this.
    getAdminFromRequest.mockResolvedValueOnce({ _id: "ADMIN1" });
    upsertPlanByPlanId.mockResolvedValueOnce({ planId: "test_1rs" });
    await POST(
      makeReq("POST", {
        action: "enable",
        razorpayPlanMonthly: "rzp_x",
      })
    );
    const settingArg = upsertSetting.mock.calls[0][2];
    expect(settingArg.updatedBy).toBe("undefined undefined");
  });

  it("admin with empty-string firstName + lastName → fallback fires → updatedBy='admin'", async () => {
    getAdminFromRequest.mockResolvedValueOnce({
      _id: "ADMIN1",
      firstName: "",
      lastName: "",
    });
    upsertPlanByPlanId.mockResolvedValueOnce({ planId: "test_1rs" });
    await POST(
      makeReq("POST", {
        action: "enable",
        razorpayPlanMonthly: "rzp_x",
      })
    );
    const settingArg = upsertSetting.mock.calls[0][2];
    expect(settingArg.updatedBy).toBe("admin");
  });
});

describe("POST — zod schema", () => {
  it("invalid action → 400; no DB write", async () => {
    const res = await POST(makeReq("POST", { action: "burn-it-down" }));
    expect(res.status).toBe(400);
    expect(setPlanActive).not.toHaveBeenCalled();
    expect(upsertPlanByPlanId).not.toHaveBeenCalled();
  });
});

describe("Outer catch", () => {
  it("setPlanActive throw → 500 SERVER_ERROR", async () => {
    setPlanActive.mockRejectedValueOnce(new Error("Mongo blip"));
    const res = await POST(makeReq("POST", { action: "disable" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("SERVER_ERROR");
  });
});
