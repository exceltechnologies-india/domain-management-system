/**
 * Tests for `app/api/orders/route.ts` (slice 7gn, part 1). Customer-
 * facing order list. The path is `/api/orders` (not `/api/user/...`)
 * but the handler is user-scoped — anyone who can reach it gets
 * THEIR own orders only.
 *
 * Pins:
 *  - Auth dual-path: AuthService first; if null, getToken with
 *    AUTH_SECRET; if token has an id, getUserById confirms the
 *    user exists AND isActive. Deactivated account with valid JWT
 *    → 401 UNAUTHORIZED (NO data fetch).
 *  - Both auth paths missing → 401
 *  - listOrdersForUser called with String(user._id) AND limit:50
 *    (default cap — list view is paginated client-side or via
 *    "view all" navigation; the bare GET caps to 50)
 *  - Response shape: { success:true, orders }
 *  - Service throw → 500 'Failed to fetch orders' (no leak)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const getToken = vi.hoisted(() => vi.fn());
vi.mock("next-auth/jwt", () => ({ getToken }));
vi.mock("@/lib/auth-secret", () => ({ AUTH_SECRET: "test-secret" }));

const getUserById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserById }));

const listOrdersForUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({ listOrdersForUser }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/orders/route";

function makeReq() {
  return new NextRequest("https://example.com/api/orders", { method: "GET" });
}

const user = { _id: "U1", email: "alice@example.com", isActive: true };

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(user);
  getToken.mockReset();
  getUserById.mockReset();
  listOrdersForUser.mockReset();
});

// ─── Auth — primary path ─────────────────────────────────────────
describe("Auth — AuthService primary path", () => {
  it("AuthService user → proceeds; getToken NOT called", async () => {
    listOrdersForUser.mockResolvedValueOnce([]);
    await GET(makeReq());
    expect(getToken).not.toHaveBeenCalled();
  });
});

// ─── Auth — JWT fallback path ────────────────────────────────────
describe("Auth — getToken fallback", () => {
  it("AuthService null + getToken returns id + active user → proceeds", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    getToken.mockResolvedValueOnce({ id: "U-JWT" });
    getUserById.mockResolvedValueOnce({
      _id: "U-JWT",
      email: "j@x.com",
      isActive: true,
    });
    listOrdersForUser.mockResolvedValueOnce([]);

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    expect(listOrdersForUser).toHaveBeenCalledWith("U-JWT", { limit: 50 });
  });

  it("getToken returns id but getUserById null → 401 UNAUTHORIZED; NO list", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    getToken.mockResolvedValueOnce({ id: "U-DELETED" });
    getUserById.mockResolvedValueOnce(null);

    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    expect(listOrdersForUser).not.toHaveBeenCalled();
  });

  it("getUserById returns user but isActive=false → 401; NO list", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    getToken.mockResolvedValueOnce({ id: "U-DEAD" });
    getUserById.mockResolvedValueOnce({
      _id: "U-DEAD",
      isActive: false,
    });

    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    expect(listOrdersForUser).not.toHaveBeenCalled();
  });

  it("AuthService null + no token → 401", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    getToken.mockResolvedValueOnce(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });
});

// ─── IDOR + service call shape ───────────────────────────────────
describe("IDOR + service call shape", () => {
  it("listOrdersForUser called with String(user._id) AND limit:50", async () => {
    listOrdersForUser.mockResolvedValueOnce([]);
    await GET(makeReq());
    expect(listOrdersForUser).toHaveBeenCalledWith("U1", { limit: 50 });
  });
});

// ─── Response shape ──────────────────────────────────────────────
describe("Response shape", () => {
  it("returns { success:true, orders }", async () => {
    listOrdersForUser.mockResolvedValueOnce([
      { orderId: "ORD-1" },
      { orderId: "ORD-2" },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      orders: [{ orderId: "ORD-1" }, { orderId: "ORD-2" }],
    });
  });
});

// ─── Error handling ──────────────────────────────────────────────
describe("Error handling", () => {
  it("service throw → 500 'Failed to fetch orders' (no leak)", async () => {
    listOrdersForUser.mockRejectedValueOnce(new Error("DB blew up"));
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch orders");
    expect(body.error).not.toContain("DB blew up");
  });
});
