/**
 * Tests for `app/api/user/hosting/[id]/auto-renew/route.ts` (slice
 * 7gy, part 2). Customer toggles auto-renew on one of their own
 * hosting accounts.
 *
 * Pins:
 *  - Auth gate FIRST → 401
 *  - zod schema: `{ autoRenew: boolean }` — STRICT boolean (string
 *    'true' / number 1 should reject); missing field → 400
 *  - **IDOR via findUserHostingById(id, user._id)** — second arg
 *    pinned: a non-owner gets 404 not 200
 *  - Not found → 404 'Hosting not found'
 *  - **Status precondition**: hosting.status !== 'active' → 400
 *    'Auto-renewal can only be changed on active hosting' (NO
 *    save). Pinned because the user shouldn't be able to flip
 *    auto-renew on a suspended/terminated account — that would
 *    create a customer-confusion vector ("I turned auto-renew on,
 *    why didn't my account come back?")
 *  - Save shape: hosting.autoRenew flipped to the requested value;
 *    hosting.save() called once
 *  - Response carries success + the new autoRenew + billingType
 *    ONLY (curated)
 *  - Outer catch → 500 'Failed to update auto-renewal'
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const findUserHostingById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hostings", () => ({ findUserHostingById }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { PATCH } from "@/app/api/user/hosting/[id]/auto-renew/route";

function makeReq(body: unknown) {
  return new NextRequest(
    "https://example.com/api/user/hosting/H1/auto-renew",
    {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }
  );
}

function paramsOf(id: string) {
  return { params: Promise.resolve({ id }) };
}

const user = { _id: "U1", email: "alice@example.com" };

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(user);
  findUserHostingById.mockReset();
});

describe("Auth gate", () => {
  it("no user → 401; NO hosting lookup", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await PATCH(makeReq({ autoRenew: true }), paramsOf("H1"));
    expect(res.status).toBe(401);
    expect(findUserHostingById).not.toHaveBeenCalled();
  });
});

describe("Body validation (strict boolean)", () => {
  it("missing autoRenew → 400", async () => {
    const res = await PATCH(makeReq({}), paramsOf("H1"));
    expect(res.status).toBe(400);
    expect(findUserHostingById).not.toHaveBeenCalled();
  });

  it("string 'true' (not boolean) → 400", async () => {
    const res = await PATCH(
      makeReq({ autoRenew: "true" }),
      paramsOf("H1")
    );
    expect(res.status).toBe(400);
  });

  it("number 1 (not boolean) → 400", async () => {
    const res = await PATCH(
      makeReq({ autoRenew: 1 }),
      paramsOf("H1")
    );
    expect(res.status).toBe(400);
  });

  it("null (not boolean) → 400", async () => {
    const res = await PATCH(
      makeReq({ autoRenew: null }),
      paramsOf("H1")
    );
    expect(res.status).toBe(400);
  });
});

describe("IDOR — findUserHostingById", () => {
  it("called with (id, user._id) — scope pinned", async () => {
    findUserHostingById.mockResolvedValueOnce(null);
    await PATCH(makeReq({ autoRenew: true }), paramsOf("H_TARGET"));
    expect(findUserHostingById).toHaveBeenCalledWith("H_TARGET", "U1");
  });

  it("non-owner / not found → 404 'Hosting not found'", async () => {
    findUserHostingById.mockResolvedValueOnce(null);
    const res = await PATCH(
      makeReq({ autoRenew: true }),
      paramsOf("H_OTHER_USER")
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Hosting not found");
  });
});

describe("Status precondition (active only)", () => {
  it.each(["suspended", "terminated", "pending", "expired"])(
    "status=%p → 400 'Auto-renewal can only be changed on active hosting'; NO save",
    async (status) => {
      const save = vi.fn().mockResolvedValue(undefined);
      findUserHostingById.mockResolvedValueOnce({
        _id: "H1",
        domainName: "alice.com",
        status,
        autoRenew: false,
        save,
      });
      const res = await PATCH(
        makeReq({ autoRenew: true }),
        paramsOf("H1")
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("active hosting");
      expect(save).not.toHaveBeenCalled();
    }
  );

  it("status='active' → proceeds to save", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    findUserHostingById.mockResolvedValueOnce({
      _id: "H1",
      domainName: "alice.com",
      status: "active",
      autoRenew: false,
      billingType: "manual",
      save,
    });
    const res = await PATCH(
      makeReq({ autoRenew: true }),
      paramsOf("H1")
    );
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe("Save + response shape", () => {
  it("autoRenew=true applied; response carries success + autoRenew + billingType only", async () => {
    const captured: { autoRenew?: boolean } = {};
    const save = vi.fn().mockImplementation(function (this: {
      autoRenew: boolean;
    }) {
      captured.autoRenew = this.autoRenew;
      return Promise.resolve();
    });
    findUserHostingById.mockResolvedValueOnce({
      _id: "H_INTERNAL",
      domainName: "alice.com",
      status: "active",
      autoRenew: false,
      billingType: "razorpay-subscription",
      save,
    });

    const res = await PATCH(
      makeReq({ autoRenew: true }),
      paramsOf("H1")
    );
    expect(res.status).toBe(200);
    expect(captured.autoRenew).toBe(true);

    const body = await res.json();
    expect(body).toEqual({
      success: true,
      autoRenew: true,
      billingType: "razorpay-subscription",
    });
    // Internal fields not leaked
    const json = JSON.stringify(body);
    expect(json).not.toContain("H_INTERNAL");
    expect(json).not.toContain("alice.com"); // domainName not in response
  });

  it("autoRenew=false correctly applied + reflected", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const hosting = {
      _id: "H1",
      domainName: "x.com",
      status: "active",
      autoRenew: true,
      billingType: "manual",
      save,
    };
    findUserHostingById.mockResolvedValueOnce(hosting);

    const res = await PATCH(
      makeReq({ autoRenew: false }),
      paramsOf("H1")
    );
    const body = await res.json();
    expect(body.autoRenew).toBe(false);
    expect(hosting.autoRenew).toBe(false);
  });
});

describe("Outer catch", () => {
  it("findUserHostingById throw → 500 'Failed to update auto-renewal'", async () => {
    findUserHostingById.mockRejectedValueOnce(new Error("Mongo timeout"));
    const res = await PATCH(makeReq({ autoRenew: true }), paramsOf("H1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to update auto-renewal");
    expect(body.error).not.toContain("Mongo");
  });
});
