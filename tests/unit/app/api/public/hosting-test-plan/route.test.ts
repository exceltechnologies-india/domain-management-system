/**
 * Tests for `app/api/public/hosting-test-plan/route.ts` (slice 7gq,
 * part 2). Public, unauthenticated. Returns whether the ₹1 test
 * plan is available for purchase + its full plan card.
 *
 * Security policy: the test plan is a heavily-discounted ($0.01-
 * level) offering — it must NOT be returned to the public UI by
 * accident. Two AND conditions:
 *   (1) `hosting_test_plan_enabled` setting === true (STRICT
 *       boolean — string 'true' should NOT enable it; pinned)
 *   (2) the `test_1rs` HostingPlan document exists AND isActive
 *
 * Anything else short-circuits to `{ enabled: false }`.
 *
 * Pins:
 *  - getSettingValue called with ('hosting_test_plan_enabled',
 *    false) — default arg is FALSE (fail-closed; pinned)
 *  - Setting !== boolean true → `{ enabled: false }` (no plan
 *    lookup made); covers: false, undefined, null, string 'true'
 *    (only literal `true` enables)
 *  - Plan lookup uses `{ planId: 'test_1rs', isActive: true }`
 *    — both fields pinned (an admin who toggles isActive=false
 *    must immediately disable the public flag)
 *  - Plan not found → `{ enabled: false }` (no leak; consistent
 *    fail-closed)
 *  - Plan found → response shape includes razorpayPlans.monthly
 *    flattened to razorpayPlanMonthly; directAdminPackage
 *    flattened to serverPackage
 *  - **Outer catch SWALLOWS errors → `{ enabled: false }`** (NOT
 *    500; the catch is intentionally generous — anti-DoS, anti-
 *    misconfig-leak. If the DB is down, the public UI just shows
 *    no test plan rather than exposing the error.)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const connectDB = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

const getSettingValue = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/settings", () => ({ getSettingValue }));

const findOne = vi.hoisted(() => vi.fn());
vi.mock("@/models/HostingPlan", () => ({
  default: { findOne: (...args: unknown[]) => findOne(...args) },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/public/hosting-test-plan/route";

function makeReq() {
  return new NextRequest("https://example.com/api/public/hosting-test-plan", {
    method: "GET",
  });
}

function chainable(value: unknown) {
  return { lean: vi.fn().mockResolvedValue(value) };
}

beforeEach(() => {
  connectDB.mockClear().mockResolvedValue(undefined);
  getSettingValue.mockReset();
  findOne.mockReset();
});

describe("Default arg to getSettingValue is FALSE (fail-closed)", () => {
  it("getSettingValue called with ('hosting_test_plan_enabled', false)", async () => {
    getSettingValue.mockResolvedValueOnce(false);
    await GET(makeReq());
    expect(getSettingValue).toHaveBeenCalledWith(
      "hosting_test_plan_enabled",
      false
    );
  });
});

describe("Setting gate (strict boolean true required)", () => {
  it.each([
    ["false", false],
    ["undefined", undefined],
    ["null", null],
    ["string 'true' — NOT enabled (strict boolean only)", "true"],
    ["number 1 — NOT enabled", 1],
  ])("%s → { enabled:false }; NO plan lookup", async (_label, val) => {
    getSettingValue.mockResolvedValueOnce(val as never);
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ enabled: false });
    expect(findOne).not.toHaveBeenCalled();
  });

  it("literal boolean true → proceeds to plan lookup", async () => {
    getSettingValue.mockResolvedValueOnce(true);
    findOne.mockReturnValueOnce(chainable(null));
    await GET(makeReq());
    expect(findOne).toHaveBeenCalledWith({
      planId: "test_1rs",
      isActive: true,
    });
  });
});

describe("Plan lookup", () => {
  it("plan filter pins both planId='test_1rs' AND isActive:true (admin toggling isActive=false immediately disables)", async () => {
    getSettingValue.mockResolvedValueOnce(true);
    findOne.mockReturnValueOnce(chainable(null));
    await GET(makeReq());
    expect(findOne).toHaveBeenCalledWith({
      planId: "test_1rs",
      isActive: true,
    });
  });

  it("plan not found → { enabled:false } (fail-closed even with the flag enabled)", async () => {
    getSettingValue.mockResolvedValueOnce(true);
    findOne.mockReturnValueOnce(chainable(null));
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body).toEqual({ enabled: false });
  });

  it("plan found → enabled:true with flattened shape (directAdminPackage → serverPackage, razorpayPlans.monthly → razorpayPlanMonthly)", async () => {
    getSettingValue.mockResolvedValueOnce(true);
    findOne.mockReturnValueOnce(
      chainable({
        planId: "test_1rs",
        name: "₹1 Test Plan",
        description: "QA fixture",
        price: 1,
        currency: "INR",
        features: ["1GB", "1 domain"],
        directAdminPackage: "test_plan_pkg",
        razorpayPlans: { monthly: "plan_TEST_MONTHLY" },
        isActive: true,
      })
    );

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body).toEqual({
      enabled: true,
      plan: {
        id: "test_1rs",
        name: "₹1 Test Plan",
        description: "QA fixture",
        price: 1,
        currency: "INR",
        features: ["1GB", "1 domain"],
        serverPackage: "test_plan_pkg",
        razorpayPlanMonthly: "plan_TEST_MONTHLY",
      },
    });
  });

  it("plan found but no razorpayPlans.monthly → razorpayPlanMonthly is undefined (allowed)", async () => {
    getSettingValue.mockResolvedValueOnce(true);
    findOne.mockReturnValueOnce(
      chainable({
        planId: "test_1rs",
        name: "₹1",
        description: "x",
        price: 1,
        currency: "INR",
        features: [],
        directAdminPackage: "pkg",
        // razorpayPlans missing entirely
      })
    );
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.plan.razorpayPlanMonthly).toBeUndefined();
  });
});

describe("Outer catch — SWALLOWED to { enabled:false }", () => {
  it("connectDB throw → { enabled:false } (NOT 500; anti-misconfig-leak)", async () => {
    connectDB.mockRejectedValueOnce(new Error("Mongo connection refused"));
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ enabled: false });
  });

  it("getSettingValue throw → { enabled:false }", async () => {
    getSettingValue.mockRejectedValueOnce(new Error("Settings DB error"));
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ enabled: false });
  });

  it("HostingPlan.findOne throw → { enabled:false }", async () => {
    getSettingValue.mockResolvedValueOnce(true);
    findOne.mockImplementationOnce(() => {
      throw new Error("model crash");
    });
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ enabled: false });
  });
});
