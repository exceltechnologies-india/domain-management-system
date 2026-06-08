/**
 * Tests for `app/api/payments/cancel-subscription/route.ts` (slice
 * 7gj, part 2). Customer-initiated subscription cancellation.
 *
 * Threat model: a customer must NOT be able to cancel another
 * customer's subscription by submitting their hostingId.
 *
 * Pins:
 *  - Auth gate FIRST → 401 (NO findUserHostingById, NO Razorpay)
 *  - zod schema: hostingId required via Schemas.id (ObjectId-shaped)
 *  - **IDOR guard**: findUserHostingById(hostingId, user.id) —
 *    service is scoped by user.id; non-owner sees 404 'Hosting
 *    service not found' (anti-enumeration: ambiguous between
 *    "doesn't exist" and "not yours")
 *  - **No-subscription guard**: hosting exists but has no
 *    subscriptionId → 400 'No active subscription found' (NO
 *    Razorpay call — prevents calling cancel() with undefined)
 *  - Razorpay cancel called with hosting.subscriptionId
 *  - On success: hosting.autoRenew = false; hosting.save() called
 *    (status NOT changed; user keeps service until term ends)
 *  - Success message includes "end of the current term" (sets
 *    user expectation correctly)
 *  - Razorpay failure → 500 with GENERIC message (NO raw error
 *    fragments leaked; can contain subscription / account-id
 *    strings)
 *  - Outer catch → 500 'Internal server error'
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const findUserHostingById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hostings", () => ({ findUserHostingById }));

const cancelSubscription = vi.hoisted(() => vi.fn());
vi.mock("@/lib/razorpay", () => ({
  RazorpayService: { cancelSubscription },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/payments/cancel-subscription/route";

function makeReq(body: unknown) {
  return new NextRequest("https://example.com/api/payments/cancel-subscription", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const user = { id: "U1", _id: "U1", email: "alice@example.com" };
// 24-hex-char ObjectId-shaped string for Schemas.id
const HOSTING_ID = "507f1f77bcf86cd799439011";

function freshHosting(overrides: Record<string, unknown> = {}) {
  return {
    _id: HOSTING_ID,
    userId: "U1",
    domainName: "example.com",
    subscriptionId: "sub_LIVE_ABC",
    autoRenew: true,
    status: "active",
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(user);
  findUserHostingById.mockReset();
  cancelSubscription.mockReset();
});

// ─── Auth gate ────────────────────────────────────────────────────
describe("Auth gate FIRST", () => {
  it("no user → 401; NO findUserHostingById, NO Razorpay cancel", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ hostingId: HOSTING_ID }));
    expect(res.status).toBe(401);
    expect(findUserHostingById).not.toHaveBeenCalled();
    expect(cancelSubscription).not.toHaveBeenCalled();
  });
});

// ─── Body validation ─────────────────────────────────────────────
describe("Body validation", () => {
  it("missing hostingId → 400 VALIDATION_ERROR", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
  });

  it("malformed hostingId (not ObjectId-shaped) → 400", async () => {
    const res = await POST(makeReq({ hostingId: "not-an-id" }));
    expect(res.status).toBe(400);
    expect(findUserHostingById).not.toHaveBeenCalled();
  });
});

// ─── IDOR guard ──────────────────────────────────────────────────
describe("IDOR guard — findUserHostingById scope", () => {
  it("findUserHostingById called with (hostingId, user.id) — not just hostingId", async () => {
    findUserHostingById.mockResolvedValueOnce(null);
    await POST(makeReq({ hostingId: HOSTING_ID }));
    expect(findUserHostingById).toHaveBeenCalledWith(HOSTING_ID, "U1");
  });

  it("not-owner returns null → 404 'Hosting service not found' (NOT 'forbidden' — anti-enumeration)", async () => {
    findUserHostingById.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ hostingId: HOSTING_ID }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Hosting service not found");
    expect(cancelSubscription).not.toHaveBeenCalled();
  });
});

// ─── No-subscription guard ───────────────────────────────────────
describe("No-subscription guard", () => {
  it("hosting found but subscriptionId missing → 400; NO Razorpay call (no cancel of undefined)", async () => {
    findUserHostingById.mockResolvedValueOnce(
      freshHosting({ subscriptionId: undefined })
    );
    const res = await POST(makeReq({ hostingId: HOSTING_ID }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("No active subscription found for this hosting");
    expect(cancelSubscription).not.toHaveBeenCalled();
  });
});

// ─── Happy path ──────────────────────────────────────────────────
describe("Happy path", () => {
  it("calls Razorpay cancel with hosting.subscriptionId; sets autoRenew=false + saves; status untouched", async () => {
    const h = freshHosting();
    findUserHostingById.mockResolvedValueOnce(h);
    cancelSubscription.mockResolvedValueOnce(undefined);

    const res = await POST(makeReq({ hostingId: HOSTING_ID }));
    expect(res.status).toBe(200);
    expect(cancelSubscription).toHaveBeenCalledWith("sub_LIVE_ABC");
    expect(h.autoRenew).toBe(false);
    // Status NOT modified — user keeps service until term ends
    expect(h.status).toBe("active");
    expect(h.save).toHaveBeenCalledTimes(1);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toContain("end of the current term");
  });
});

// ─── Razorpay error masking ──────────────────────────────────────
describe("Razorpay error masking", () => {
  it("Razorpay throw → 500 GENERIC; raw subscription / account fragments NOT leaked", async () => {
    findUserHostingById.mockResolvedValueOnce(freshHosting());
    cancelSubscription.mockRejectedValueOnce(
      new Error(
        "rz_error: cannot cancel sub_LIVE_ABC, account=acc_PROD_KEY12345 already in mid-cycle"
      )
    );

    const res = await POST(makeReq({ hostingId: HOSTING_ID }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe(
      "Failed to cancel subscription. Please try again or contact support."
    );
    expect(body.error).not.toContain("sub_LIVE_ABC");
    expect(body.error).not.toContain("acc_PROD_KEY12345");
    expect(body.error).not.toContain("account=");
  });

  it("if Razorpay throws, hosting.save() is NOT called (no partial state)", async () => {
    const h = freshHosting();
    findUserHostingById.mockResolvedValueOnce(h);
    cancelSubscription.mockRejectedValueOnce(new Error("rz down"));

    await POST(makeReq({ hostingId: HOSTING_ID }));
    expect(h.save).not.toHaveBeenCalled();
    expect(h.autoRenew).toBe(true); // unchanged
  });
});

// ─── Outer catch ──────────────────────────────────────────────────
describe("Outer catch", () => {
  it("findUserHostingById throw → 500 'Internal server error'", async () => {
    findUserHostingById.mockRejectedValueOnce(new Error("DB blew up"));
    const res = await POST(makeReq({ hostingId: HOSTING_ID }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
  });
});
