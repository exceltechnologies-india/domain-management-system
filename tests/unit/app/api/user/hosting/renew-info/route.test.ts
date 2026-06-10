/**
 * Tests for `app/api/user/hosting/renew-info/route.ts` (slice 7gu,
 * part 2). Customer fetches the renewal-pricing card for one of
 * their hosting accounts. The 1-year-only business rule is the
 * main pin — a refactor that exposes a periodMonths URL param
 * would let customers underpay.
 *
 * Pins:
 *  - Auth gate FIRST → 401 UNAUTHORIZED
 *  - **Missing ?domainName** → 400 INVALID_PARAM (defensive; the
 *    UI always sends this)
 *  - **IDOR via findUserHosting(String(user._id), { domainName })**
 *    — second arg pinned: scopes lookup by user._id. domainName
 *    is LOWERCASED before the lookup (case-insensitive match
 *    against the DB store).
 *  - hosting not found → 404 NOT_FOUND
 *  - getPlanByPlanId(hosting.planId) returns null → 404
 *    PLAN_NOT_FOUND (defensive — if plan was deleted but hosting
 *    still references it)
 *  - **Business rule: 1-year-only renewal** — price = plan.price
 *    × 12; periodMonths = 12; periodYears = 1. All three pinned
 *    VERBATIM so a future "let customer pick 6/12/24 months"
 *    change fails this test and forces explicit review.
 *  - Currency defaults to 'INR' when plan.currency missing
 *  - Response includes domainName / currentStatus / currentExpiry
 *    / planName / renewalPricing — but NOT the raw plan doc
 *    (avoids leaking internal plan flags like isActive)
 *  - Outer catch → 500 INTERNAL_ERROR 'Failed to get renewal info'
 *    (no leak)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const findUserHosting = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hostings", () => ({ findUserHosting }));

const getPlanByPlanId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hosting-plans", () => ({ getPlanByPlanId }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/user/hosting/renew-info/route";

function makeReq(qs = "") {
  const url = qs
    ? `https://example.com/api/user/hosting/renew-info?${qs}`
    : "https://example.com/api/user/hosting/renew-info";
  return new NextRequest(url, { method: "GET" });
}

const user = { _id: "U1", email: "alice@example.com" };

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(user);
  findUserHosting.mockReset();
  getPlanByPlanId.mockReset();
});

describe("Auth gate FIRST", () => {
  it("no user → 401 UNAUTHORIZED; NO hosting lookup", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq("domainName=example.com"));
    expect(res.status).toBe(401);
    expect(findUserHosting).not.toHaveBeenCalled();
  });
});

describe("Missing ?domainName guard", () => {
  it("no query param → 400 INVALID_PARAM; NO hosting lookup", async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_PARAM");
    expect(findUserHosting).not.toHaveBeenCalled();
  });
});

describe("IDOR scope — findUserHosting", () => {
  it("called with (String(user._id), { domainName: lowercased }) — scope pinned", async () => {
    findUserHosting.mockResolvedValueOnce(null);
    await GET(makeReq("domainName=ALICE.COM"));
    expect(findUserHosting).toHaveBeenCalledWith("U1", {
      domainName: "alice.com",
    });
  });

  it("hosting not found → 404 NOT_FOUND", async () => {
    findUserHosting.mockResolvedValueOnce(null);
    const res = await GET(makeReq("domainName=stranger.com"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });
});

describe("Plan-lookup defensive guard", () => {
  it("getPlanByPlanId null → 404 PLAN_NOT_FOUND (hosting references a deleted plan)", async () => {
    findUserHosting.mockResolvedValueOnce({
      domainName: "alice.com",
      planId: "plan_ORPHAN",
      status: "active",
      expiryDate: new Date("2027-01-01"),
    });
    getPlanByPlanId.mockResolvedValueOnce(null);

    const res = await GET(makeReq("domainName=alice.com"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("PLAN_NOT_FOUND");
  });
});

describe("Business rule — 1-year-only renewal pricing (pinned VERBATIM)", () => {
  it("price = plan.price × 12; periodMonths = 12; periodYears = 1", async () => {
    findUserHosting.mockResolvedValueOnce({
      domainName: "alice.com",
      planId: "plan_STARTER",
      status: "active",
      expiryDate: new Date("2027-01-01"),
    });
    getPlanByPlanId.mockResolvedValueOnce({
      planId: "plan_STARTER",
      name: "Starter",
      price: 150,
      currency: "INR",
    });

    const res = await GET(makeReq("domainName=alice.com"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.renewalPricing).toEqual({
      price: 1800, // 150 × 12
      currency: "INR",
      periodMonths: 12,
      periodYears: 1,
    });
  });

  it("currency defaults to 'INR' when plan.currency is missing", async () => {
    findUserHosting.mockResolvedValueOnce({
      domainName: "alice.com",
      planId: "plan_X",
      status: "active",
      expiryDate: new Date("2027-01-01"),
    });
    getPlanByPlanId.mockResolvedValueOnce({
      planId: "plan_X",
      name: "X",
      price: 99,
      // no currency
    });

    const body = await (await GET(makeReq("domainName=alice.com"))).json();
    expect(body.data.renewalPricing.currency).toBe("INR");
  });
});

describe("Response shape", () => {
  it("returns curated fields ONLY (no raw plan doc / no internal hosting flags)", async () => {
    findUserHosting.mockResolvedValueOnce({
      _id: "H_INTERNAL_ID",
      domainName: "alice.com",
      planId: "plan_X",
      status: "active",
      expiryDate: new Date("2027-01-01"),
      autoRenew: true,
      directAdminUsername: "alice_da",
      userId: "U1",
    });
    getPlanByPlanId.mockResolvedValueOnce({
      _id: "PLAN_DOC_INTERNAL",
      planId: "plan_X",
      name: "X",
      price: 99,
      currency: "INR",
      isActive: true,
      directAdminPackage: "x_pkg",
      razorpayPlans: { monthly: "plan_RZP_X" },
    });

    const body = await (await GET(makeReq("domainName=alice.com"))).json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual({
      domainName: "alice.com",
      currentStatus: "active",
      currentExpiry: new Date("2027-01-01").toISOString(),
      planName: "X",
      renewalPricing: {
        price: 1188, // 99 × 12
        currency: "INR",
        periodMonths: 12,
        periodYears: 1,
      },
    });
    // Internal fields should NOT leak through
    const json = JSON.stringify(body.data);
    expect(json).not.toContain("H_INTERNAL_ID");
    expect(json).not.toContain("PLAN_DOC_INTERNAL");
    expect(json).not.toContain("razorpayPlans");
    expect(json).not.toContain("directAdminPackage");
    expect(json).not.toContain("autoRenew");
    expect(json).not.toContain("alice_da");
  });
});

describe("Outer catch", () => {
  it("findUserHosting throw → 500 INTERNAL_ERROR 'Failed to get renewal info' (no leak)", async () => {
    findUserHosting.mockRejectedValueOnce(new Error("Mongo timeout"));
    const res = await GET(makeReq("domainName=alice.com"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.error).toBe("Failed to get renewal info");
    expect(body.error).not.toContain("Mongo");
  });
});
