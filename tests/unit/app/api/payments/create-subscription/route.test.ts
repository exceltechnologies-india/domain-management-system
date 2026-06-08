/**
 * Tests for `app/api/payments/create-subscription/route.ts` (slice
 * 7gj, part 1). Customer-initiated Razorpay subscription creation.
 *
 * Pins:
 *  - Auth gate FIRST → 401 (NO RazorpayService.createSubscription
 *    call; subscription creation costs $$ and must not happen
 *    without an authenticated user)
 *  - zod body validation: planId required, interval optional enum
 *    of monthly|yearly, domainName trim+3-253 chars
 *  - **createSubscription called with (planId, user.id, domainName)
 *    — exact arg order pinned** (a regression where user.id and
 *    domainName are swapped would silently bind subscriptions to
 *    the wrong account)
 *  - Razorpay failure → 500 with **generic message** ("Failed to
 *    create subscription. Please try again or contact support.")
 *    — NOT the raw RazorpayError, which can contain account-id /
 *    key fragments / retry tokens (info disclosure)
 *  - Outer catch → 500 'Internal server error'
 *  - Happy path response shape: success, subscriptionId,
 *    short_url, planId echo, interval echo
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const createSubscription = vi.hoisted(() => vi.fn());
vi.mock("@/lib/razorpay", () => ({
  RazorpayService: { createSubscription },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/payments/create-subscription/route";

function makeReq(body: unknown) {
  return new NextRequest("https://example.com/api/payments/create-subscription", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const user = { id: "U1", _id: "U1", email: "alice@example.com" };

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(user);
  createSubscription.mockReset();
});

// ─── Auth gate ────────────────────────────────────────────────────
describe("Auth gate FIRST", () => {
  it("no user → 401; NO Razorpay call (subscriptions cost money)", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await POST(
      makeReq({ planId: "plan_X", domainName: "example.com" })
    );
    expect(res.status).toBe(401);
    expect(createSubscription).not.toHaveBeenCalled();
  });
});

// ─── Body validation ─────────────────────────────────────────────
describe("Body validation", () => {
  it("missing planId → 400 VALIDATION_ERROR", async () => {
    const res = await POST(makeReq({ domainName: "example.com" }));
    expect(res.status).toBe(400);
    expect(createSubscription).not.toHaveBeenCalled();
  });

  it("missing domainName → 400", async () => {
    const res = await POST(makeReq({ planId: "plan_X" }));
    expect(res.status).toBe(400);
  });

  it("invalid interval value → 400", async () => {
    const res = await POST(
      makeReq({
        planId: "plan_X",
        domainName: "example.com",
        interval: "biennial",
      })
    );
    expect(res.status).toBe(400);
  });

  it("interval missing is allowed (optional)", async () => {
    createSubscription.mockResolvedValueOnce({
      id: "sub_X",
      short_url: "https://rzp.io/x",
    });
    const res = await POST(
      makeReq({ planId: "plan_X", domainName: "example.com" })
    );
    expect(res.status).toBe(200);
  });

  it("domainName trimmed by schema", async () => {
    createSubscription.mockResolvedValueOnce({
      id: "sub_X",
      short_url: "https://rzp.io/x",
    });
    await POST(
      makeReq({ planId: "plan_X", domainName: "  example.com  " })
    );
    expect(createSubscription).toHaveBeenCalledWith(
      "plan_X",
      "U1",
      "example.com"
    );
  });
});

// ─── Razorpay call shape ─────────────────────────────────────────
describe("createSubscription called with exact arg order (planId, user.id, domainName)", () => {
  it("pins arg order — a regression that swaps user.id with domainName would silently misroute subscriptions", async () => {
    createSubscription.mockResolvedValueOnce({
      id: "sub_X",
      short_url: "https://rzp.io/x",
    });
    await POST(
      makeReq({
        planId: "plan_TEST",
        domainName: "example.com",
        interval: "monthly",
      })
    );
    expect(createSubscription).toHaveBeenCalledTimes(1);
    expect(createSubscription).toHaveBeenCalledWith(
      "plan_TEST",
      "U1",
      "example.com"
    );
  });
});

// ─── Happy path response shape ────────────────────────────────────
describe("Happy path response shape", () => {
  it("returns success + subscriptionId + short_url + planId + interval", async () => {
    createSubscription.mockResolvedValueOnce({
      id: "sub_ABC",
      short_url: "https://rzp.io/i/abc",
    });
    const res = await POST(
      makeReq({
        planId: "plan_GOLD",
        domainName: "example.com",
        interval: "yearly",
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      subscriptionId: "sub_ABC",
      short_url: "https://rzp.io/i/abc",
      planId: "plan_GOLD",
      interval: "yearly",
    });
  });
});

// ─── Razorpay error masking (info-disclosure prevention) ──────────
describe("Razorpay error masking", () => {
  it("Razorpay throw → 500 with GENERIC message; NO raw error fragment in client response", async () => {
    createSubscription.mockRejectedValueOnce(
      new Error(
        "Razorpay error: account_id=acc_TESTKEY123 invalid plan reference"
      )
    );
    const res = await POST(
      makeReq({ planId: "plan_X", domainName: "example.com" })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe(
      "Failed to create subscription. Please try again or contact support."
    );
    // Critically: account_id / key strings must NOT bleed into the client body
    expect(body.error).not.toContain("acc_TESTKEY123");
    expect(body.error).not.toContain("account_id");
  });
});

// ─── Outer catch ──────────────────────────────────────────────────
describe("Outer catch", () => {
  it("AuthService throw → 500 'Internal server error'", async () => {
    getUserFromRequest.mockRejectedValueOnce(new Error("auth blew up"));
    const res = await POST(
      makeReq({ planId: "plan_X", domainName: "example.com" })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
  });
});
