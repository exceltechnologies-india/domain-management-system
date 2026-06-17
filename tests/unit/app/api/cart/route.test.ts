/**
 * Tests for `app/api/cart/route.ts` (slice 7hv, part 1).
 *
 * Customer shopping-cart server-side sync (GET + POST + DELETE).
 *
 * Threat model:
 *  - **Restricted-TLD smuggle into checkout**: a refactor that lets
 *    a restricted TLD survive to the payment gateway would create
 *    an order we can't fulfill — customer pays, registrar refuses.
 *    Pinned: `validateAndCorrectCartItems` drops restricted TLDs on
 *    BOTH read (GET self-heal) AND write (POST).
 *  - **Period-clamp bypass**: TLDs with mandatory multi-year
 *    minimums (e.g. .ai) would 4xx at the registrar if a customer
 *    forced period=1. Pinned: per-TLD `getMinYears`/`getMaxYears`
 *    clamp on every cart item.
 *  - **Cross-tenant cart write**: `setUserCart` must be keyed on
 *    the session user._id — a body field can't override. Pinned.
 *
 * Other pins:
 *  - GET/POST/DELETE all guest-tolerant: 200 no-op for anonymous
 *  - GET self-heals (corrected cart re-saved); short-circuit if no
 *    correction needed
 *  - POST zod: array length max:50; item.passthrough preserves
 *    foreign fields
 *  - Hosting items pass through untouched (no domain-side policy)
 *  - Item missing domainName passes through (legacy/edge tolerance)
 *  - dropped[] surfaced in response only when non-empty
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const getUserCart = vi.hoisted(() => vi.fn());
const setUserCart = vi.hoisted(() => vi.fn());
const clearUserCart = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({
  getUserCart,
  setUserCart,
  clearUserCart,
}));

const isRestricted = vi.hoisted(() => vi.fn());
const getMinYears = vi.hoisted(() => vi.fn());
const getMaxYears = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tld-policies", () => ({
  isRestricted,
  getMinYears,
  getMaxYears,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET, POST, DELETE } from "@/app/api/cart/route";

function makeReq(method: "GET" | "POST" | "DELETE", body?: unknown) {
  return new NextRequest("https://example.com/api/cart", {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue({ _id: "U1" });
  getUserCart.mockReset();
  setUserCart.mockReset().mockResolvedValue(undefined);
  clearUserCart.mockReset().mockResolvedValue(undefined);
  isRestricted.mockReset().mockReturnValue(false);
  getMinYears.mockReset().mockReturnValue(1);
  getMaxYears.mockReset().mockReturnValue(10);
});

// ─────────────────── Guest-tolerant 200 no-op ───────────────────────
// Anonymous requests (no NextAuth session) used to return 401 from
// every method, which spammed the browser console for guests browsing
// the cart page (the cart store calls these endpoints on every cart
// mutation regardless of login state). The route now returns a 200
// no-op for guests instead — pinned per-method so the contract can't
// regress back to 401.

describe("Guest (no session) — 200 no-op, NOT 401", () => {
  it("GET: no user → 200 with empty cart; getUserCart NOT called", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.cart).toEqual([]);
    expect(getUserCart).not.toHaveBeenCalled();
  });

  it("POST: no user → 200 with saved:false; setUserCart NOT called (no server-side write)", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await POST(
      makeReq("POST", { cart: [{ domainName: "x.com" }] })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.saved).toBe(false);
    expect(setUserCart).not.toHaveBeenCalled();
  });

  it("DELETE: no user → 200 with cleared:false; clearUserCart NOT called", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await DELETE(makeReq("DELETE"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.cleared).toBe(false);
    expect(clearUserCart).not.toHaveBeenCalled();
  });
});

// ─────────────────────────── GET ─────────────────────────────

describe("GET — clean cart short-circuit (no re-save)", () => {
  it("cart already valid → returns it; setUserCart NOT called", async () => {
    getUserCart.mockResolvedValueOnce([
      { domainName: "ok.com", registrationPeriod: 1, itemType: "domain" },
    ]);
    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(200);
    expect(setUserCart).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.cart).toHaveLength(1);
    expect(body.dropped).toBeUndefined();
  });
});

describe("GET — restricted-TLD drop + self-heal", () => {
  it("restricted TLD dropped on read; corrected cart re-saved", async () => {
    isRestricted.mockImplementation((d: string) => d === "bad.gov.in");
    getUserCart.mockResolvedValueOnce([
      { domainName: "bad.gov.in", registrationPeriod: 1 },
      { domainName: "ok.com", registrationPeriod: 1 },
    ]);
    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cart).toHaveLength(1);
    expect(body.cart[0].domainName).toBe("ok.com");
    expect(body.dropped).toEqual(["bad.gov.in"]);
    expect(setUserCart).toHaveBeenCalledWith("U1", body.cart);
  });
});

describe("GET — period clamp", () => {
  it("period below min → clamped UP and re-saved", async () => {
    getMinYears.mockReturnValue(2); // .ai-style minimum
    getUserCart.mockResolvedValueOnce([
      { domainName: "x.ai", registrationPeriod: 1 },
    ]);
    const res = await GET(makeReq("GET"));
    const body = await res.json();
    expect(body.cart[0].registrationPeriod).toBe(2);
    expect(setUserCart).toHaveBeenCalled();
  });

  it("period above max → clamped DOWN and re-saved", async () => {
    getMaxYears.mockReturnValue(10);
    getUserCart.mockResolvedValueOnce([
      { domainName: "x.com", registrationPeriod: 99 },
    ]);
    const res = await GET(makeReq("GET"));
    const body = await res.json();
    expect(body.cart[0].registrationPeriod).toBe(10);
  });

  it("period missing → defaults to 1; clamped if < min", async () => {
    getMinYears.mockReturnValue(2);
    getUserCart.mockResolvedValueOnce([{ domainName: "x.ai" }]);
    const res = await GET(makeReq("GET"));
    const body = await res.json();
    expect(body.cart[0].registrationPeriod).toBe(2);
  });
});

describe("GET — pass-through cases", () => {
  it("hosting item passes through validator UNCHANGED (no domain-side policy)", async () => {
    isRestricted.mockReturnValue(true); // would drop a domain item
    getUserCart.mockResolvedValueOnce([
      { itemType: "hosting", planId: "starter", registrationPeriod: 1 },
    ]);
    const res = await GET(makeReq("GET"));
    const body = await res.json();
    expect(body.cart).toHaveLength(1);
    expect(body.cart[0].itemType).toBe("hosting");
  });

  it("item without domainName passes through (legacy edge)", async () => {
    isRestricted.mockReturnValue(true);
    getUserCart.mockResolvedValueOnce([
      { someOtherField: "x" }, // no domainName, no itemType
    ]);
    const res = await GET(makeReq("GET"));
    const body = await res.json();
    expect(body.cart).toHaveLength(1);
  });
});

describe("GET — outer catch", () => {
  it("getUserCart throw → 500 generic", async () => {
    getUserCart.mockRejectedValueOnce(
      new Error("Mongo down — apk_LEAK_ME")
    );
    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch cart");
    expect(JSON.stringify(body)).not.toContain("apk_LEAK_ME");
  });
});

// ─────────────────────────── POST ─────────────────────────────

describe("POST — zod schema", () => {
  it("cart array > 50 items → 400", async () => {
    const big = Array.from({ length: 51 }, () => ({
      domainName: "x.com",
      registrationPeriod: 1,
    }));
    const res = await POST(makeReq("POST", { cart: big }));
    expect(res.status).toBe(400);
    expect(setUserCart).not.toHaveBeenCalled();
  });

  it("missing 'cart' key → 400", async () => {
    const res = await POST(makeReq("POST", {}));
    expect(res.status).toBe(400);
  });

  it("invalid itemType (not 'domain'|'hosting') → 400", async () => {
    const res = await POST(
      makeReq("POST", { cart: [{ itemType: "bogus" }] })
    );
    expect(res.status).toBe(400);
  });

  it(".passthrough() preserves foreign fields (price, currency, etc.)", async () => {
    await POST(
      makeReq("POST", {
        cart: [
          {
            domainName: "x.com",
            registrationPeriod: 1,
            itemType: "domain",
            price: 999,
            currency: "INR",
            customField: "preserved",
          },
        ],
      })
    );
    const written = setUserCart.mock.calls[0][1];
    expect(written[0]).toEqual(
      expect.objectContaining({
        domainName: "x.com",
        price: 999,
        currency: "INR",
        customField: "preserved",
      })
    );
  });
});

describe("POST — anti-IDOR write scoping", () => {
  it("setUserCart keyed on session user._id (no body override possible)", async () => {
    await POST(
      makeReq("POST", {
        cart: [{ domainName: "x.com" }],
        userId: "U_HOSTILE", // ignored — not in schema
      })
    );
    expect(setUserCart).toHaveBeenCalledWith("U1", expect.any(Array));
  });
});

describe("POST — restricted-TLD drop + message", () => {
  it("1 restricted TLD dropped → message says 'Removed 1 restricted domain'", async () => {
    isRestricted.mockImplementation((d: string) => d === "bad.gov.in");
    const res = await POST(
      makeReq("POST", {
        cart: [
          { domainName: "bad.gov.in", registrationPeriod: 1 },
          { domainName: "ok.com", registrationPeriod: 1 },
        ],
      })
    );
    const body = await res.json();
    expect(body.message).toContain("Removed 1 restricted domain");
    expect(body.message).toContain("bad.gov.in");
    expect(body.dropped).toEqual(["bad.gov.in"]);
  });

  it("2 restricted dropped → plural 'domains'", async () => {
    isRestricted.mockReturnValue(true);
    const res = await POST(
      makeReq("POST", {
        cart: [
          { domainName: "a.gov.in", registrationPeriod: 1 },
          { domainName: "b.gov.in", registrationPeriod: 1 },
        ],
      })
    );
    const body = await res.json();
    expect(body.message).toContain("Removed 2 restricted domains");
  });

  it("no drops → generic 'Cart updated successfully'; dropped key absent", async () => {
    const res = await POST(
      makeReq("POST", {
        cart: [{ domainName: "ok.com", registrationPeriod: 1 }],
      })
    );
    const body = await res.json();
    expect(body.message).toBe("Cart updated successfully");
    expect(body.dropped).toBeUndefined();
  });
});

describe("POST — outer catch", () => {
  it("setUserCart throw → 500 generic", async () => {
    setUserCart.mockRejectedValueOnce(new Error("Mongo blip"));
    const res = await POST(
      makeReq("POST", { cart: [{ domainName: "x.com" }] })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to update cart");
  });
});

// ─────────────────────────── DELETE ─────────────────────────────

describe("DELETE", () => {
  it("happy path → clearUserCart called with session user._id; 200 success", async () => {
    const res = await DELETE(makeReq("DELETE"));
    expect(res.status).toBe(200);
    expect(clearUserCart).toHaveBeenCalledWith("U1");
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("clearUserCart throw → 500 generic", async () => {
    clearUserCart.mockRejectedValueOnce(new Error("Mongo blip"));
    const res = await DELETE(makeReq("DELETE"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to clear cart");
  });
});
