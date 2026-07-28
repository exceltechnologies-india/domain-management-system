/**
 * Tests for `app/api/user/hosting/cancel-trial/route.ts` (slice
 * 7hc, part 2). Customer cancels a trial hosting. Three-step
 * termination flow where each step's failure is isolated (logged,
 * doesn't abort the others).
 *
 * Important policy pin: the Order record (orderType:'hosting_trial')
 * is intentionally KEPT — the route only mutates the Hosting row.
 * That's what enforces the one-trial-per-user lifetime limit.
 *
 * Pins:
 *  - Auth gate → 401
 *  - zod hostingId via Schemas.id; malformed → 400
 *  - **IDOR via findUserHostingById(hostingId, user._id)** —
 *    second arg pinned
 *  - **isTrial precondition**: !hosting OR !hosting.isTrial → 404
 *    'Trial hosting not found'. CRITICAL — a customer must NOT
 *    be able to use this endpoint to terminate a regular (paid)
 *    hosting; the isTrial gate is what prevents that.
 *  - **Already-terminated guard**: status in {terminated, failed}
 *    → 409 'Trial is already terminated' (no double-terminate
 *    side-effects)
 *  - **3-step termination with failure isolation**:
 *      Step 1: Razorpay.cancelSubscription (if subscriptionId).
 *              Throw → log + continue.
 *      Step 2: DA.suspendUser (if directAdminUsername).
 *              Throw → log + continue.
 *      Step 3: hosting save with status='terminated', isTrial=false,
 *              autoRenew=false, billingType='manual', clear
 *              subscriptionId, clear next_action_at.
 *    Pinned: step 1 OR step 2 failing must NOT block step 3 —
 *    the hosting MUST end up flagged terminated even if the
 *    upstream cleanups fail (so the customer can see their
 *    trial is gone in their dashboard).
 *  - Skip step 1 entirely when subscriptionId absent
 *  - Skip step 2 entirely when directAdminUsername absent
 *  - 200 { success: true } on success
 *  - Outer catch (step 3 throw) → 500 'Internal server error'
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const findUserHostingById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hostings", () => ({ findUserHostingById }));

const cancelSubscription = vi.hoisted(() => vi.fn());
const revokeToken = vi.hoisted(() => vi.fn());
vi.mock("@/lib/razorpay", () => ({
  RazorpayService: { cancelSubscription, revokeToken },
}));

const suspendUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/directadmin", () => ({
  DirectAdminService: { suspendUser },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/user/hosting/cancel-trial/route";

const VALID_ID = "507f1f77bcf86cd799439011";

function makeReq(body: unknown) {
  return new NextRequest("https://example.com/api/user/hosting/cancel-trial", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const user = { _id: "U1", email: "alice@example.com" };

function trial(overrides: Record<string, unknown> = {}) {
  return {
    _id: VALID_ID,
    isTrial: true,
    status: "active",
    subscriptionId: "sub_TRIAL_LIVE",
    directAdminUsername: "alice_da",
    autoRenew: true,
    billingType: "razorpay-subscription",
    next_action_at: new Date("2026-06-25"),
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(user);
  findUserHostingById.mockReset();
  cancelSubscription.mockReset();
  revokeToken.mockReset().mockResolvedValue(true);
  suspendUser.mockReset();
});

describe("Tokens-flow trial: revokes the stored mandate token", () => {
  it("razorpayTokenId + razorpayCustomerId → revokeToken(customer, token); clears razorpayTokenId; NO cancelSubscription", async () => {
    const h = trial({
      subscriptionId: undefined,
      razorpayTokenId: "token_ABC",
      razorpayCustomerId: "cust_XYZ",
      directAdminUsername: "alice_da",
    });
    findUserHostingById.mockResolvedValueOnce(h);
    const res = await POST(makeReq({ hostingId: VALID_ID }));
    expect(res.status).toBe(200);
    expect(revokeToken).toHaveBeenCalledWith("cust_XYZ", "token_ABC");
    expect(cancelSubscription).not.toHaveBeenCalled();
    expect(h.status).toBe("terminated");
    expect((h as { razorpayTokenId?: string }).razorpayTokenId).toBeUndefined();
  });

  it("token revoke failure does NOT block termination (best-effort)", async () => {
    revokeToken.mockRejectedValueOnce(new Error("razorpay down"));
    const h = trial({ subscriptionId: undefined, razorpayTokenId: "token_ABC", razorpayCustomerId: "cust_XYZ" });
    findUserHostingById.mockResolvedValueOnce(h);
    const res = await POST(makeReq({ hostingId: VALID_ID }));
    expect(res.status).toBe(200);
    expect(h.status).toBe("terminated");
    expect((h as { razorpayTokenId?: string }).razorpayTokenId).toBeUndefined();
  });
});

describe("Auth gate", () => {
  it("no user → 401; NO further work", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ hostingId: VALID_ID }));
    expect(res.status).toBe(401);
    expect(findUserHostingById).not.toHaveBeenCalled();
  });
});

describe("Body validation", () => {
  it("missing hostingId → 400", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
  });

  it("malformed hostingId (not ObjectId-shaped) → 400", async () => {
    const res = await POST(makeReq({ hostingId: "not-an-id" }));
    expect(res.status).toBe(400);
  });
});

describe("IDOR + isTrial precondition", () => {
  it("findUserHostingById called with (hostingId, user._id)", async () => {
    findUserHostingById.mockResolvedValueOnce(null);
    await POST(makeReq({ hostingId: VALID_ID }));
    expect(findUserHostingById).toHaveBeenCalledWith(VALID_ID, "U1");
  });

  it("hosting not found → 404 'Trial hosting not found'", async () => {
    findUserHostingById.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ hostingId: VALID_ID }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Trial hosting not found");
  });

  it("**CRITICAL**: hosting found but isTrial=false → 404 (same message); cannot use this endpoint to terminate paid hosting", async () => {
    findUserHostingById.mockResolvedValueOnce(trial({ isTrial: false }));
    const res = await POST(makeReq({ hostingId: VALID_ID }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Trial hosting not found");
    expect(cancelSubscription).not.toHaveBeenCalled();
    expect(suspendUser).not.toHaveBeenCalled();
  });
});

describe("Already-terminated guard", () => {
  it.each(["terminated", "failed"])(
    "status=%p → 409 'Trial is already terminated'; NO Razorpay, NO DA, NO save",
    async (status) => {
      const h = trial({ status });
      findUserHostingById.mockResolvedValueOnce(h);
      const res = await POST(makeReq({ hostingId: VALID_ID }));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe("Trial is already terminated");
      expect(cancelSubscription).not.toHaveBeenCalled();
      expect(suspendUser).not.toHaveBeenCalled();
      expect(h.save).not.toHaveBeenCalled();
    }
  );
});

describe("3-step termination — happy path", () => {
  it("calls Razorpay.cancelSubscription + DA.suspendUser + saves the hosting flagged terminated", async () => {
    const h = trial();
    findUserHostingById.mockResolvedValueOnce(h);
    cancelSubscription.mockResolvedValueOnce(undefined);
    suspendUser.mockResolvedValueOnce(undefined);

    const res = await POST(makeReq({ hostingId: VALID_ID }));
    expect(res.status).toBe(200);

    expect(cancelSubscription).toHaveBeenCalledWith("sub_TRIAL_LIVE");
    expect(suspendUser).toHaveBeenCalledWith(
      "alice_da",
      "Trial cancelled by user"
    );

    // Final state pinned
    expect(h.status).toBe("terminated");
    expect(h.isTrial).toBe(false);
    expect(h.autoRenew).toBe(false);
    expect(h.billingType).toBe("manual");
    expect(h.subscriptionId).toBeUndefined();
    expect(h.next_action_at).toBeUndefined();
    expect(h.save).toHaveBeenCalledTimes(1);
  });

  it("subscriptionId absent → Razorpay skipped; DA + save still happen", async () => {
    const h = trial({ subscriptionId: undefined });
    findUserHostingById.mockResolvedValueOnce(h);
    suspendUser.mockResolvedValueOnce(undefined);

    const res = await POST(makeReq({ hostingId: VALID_ID }));
    expect(res.status).toBe(200);
    expect(cancelSubscription).not.toHaveBeenCalled();
    expect(suspendUser).toHaveBeenCalled();
    expect(h.save).toHaveBeenCalled();
  });

  it("directAdminUsername absent → DA suspend skipped; Razorpay + save still happen", async () => {
    const h = trial({ directAdminUsername: undefined });
    findUserHostingById.mockResolvedValueOnce(h);
    cancelSubscription.mockResolvedValueOnce(undefined);

    const res = await POST(makeReq({ hostingId: VALID_ID }));
    expect(res.status).toBe(200);
    expect(cancelSubscription).toHaveBeenCalled();
    expect(suspendUser).not.toHaveBeenCalled();
    expect(h.save).toHaveBeenCalled();
  });
});

describe("Failure isolation — upstream step throws must NOT abort step 3", () => {
  it("Razorpay throw → DA suspend STILL runs + hosting STILL saved as terminated", async () => {
    const h = trial();
    findUserHostingById.mockResolvedValueOnce(h);
    cancelSubscription.mockRejectedValueOnce(new Error("Razorpay 503"));
    suspendUser.mockResolvedValueOnce(undefined);

    const res = await POST(makeReq({ hostingId: VALID_ID }));
    expect(res.status).toBe(200);
    expect(suspendUser).toHaveBeenCalled();
    expect(h.status).toBe("terminated");
    expect(h.save).toHaveBeenCalled();
  });

  it("DA suspend throw → hosting STILL saved as terminated (customer dashboard reflects the cancellation even if DA cleanup failed)", async () => {
    const h = trial();
    findUserHostingById.mockResolvedValueOnce(h);
    cancelSubscription.mockResolvedValueOnce(undefined);
    suspendUser.mockRejectedValueOnce(new Error("DA 503"));

    const res = await POST(makeReq({ hostingId: VALID_ID }));
    expect(res.status).toBe(200);
    expect(h.status).toBe("terminated");
    expect(h.save).toHaveBeenCalled();
  });

  it("BOTH Razorpay AND DA throw → hosting STILL saved as terminated (most-pessimistic guarantee)", async () => {
    const h = trial();
    findUserHostingById.mockResolvedValueOnce(h);
    cancelSubscription.mockRejectedValueOnce(new Error("Razorpay 503"));
    suspendUser.mockRejectedValueOnce(new Error("DA 503"));

    const res = await POST(makeReq({ hostingId: VALID_ID }));
    expect(res.status).toBe(200);
    expect(h.status).toBe("terminated");
    expect(h.save).toHaveBeenCalled();
  });
});

describe("Outer catch (step 3 = hosting.save() throws)", () => {
  it("hosting.save() throw → 500 'Internal server error' generic", async () => {
    const h = trial();
    h.save = vi.fn().mockRejectedValue(new Error("Mongo write conflict"));
    findUserHostingById.mockResolvedValueOnce(h);

    const res = await POST(makeReq({ hostingId: VALID_ID }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(body.error).not.toContain("Mongo");
  });
});
