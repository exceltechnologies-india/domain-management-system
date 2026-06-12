/**
 * Tests for `app/api/user/services/status/route.ts` (slice 7hr, part 2).
 *
 * Lightweight dashboard widget endpoint: "does this customer have any
 * domains / hosting yet?" Drives a lot of UX gates (the "you're new,
 * start here" empty-state vs the populated dashboard).
 *
 * Threat model:
 *  - **Deactivated-but-token-still-valid uplift**: a deactivated user
 *    with a JWT cookie that hasn't expired could keep hitting this
 *    endpoint and trick the UI into showing them their old services.
 *    Pinned: deactivated → 401, regardless of token validity.
 *  - **Cross-tenant data via order-list leak**: listOrdersForUser
 *    must be passed the authed user's _id verbatim (no body/query
 *    override). Pinned by asserting the call arg matches the resolved
 *    user._id.
 *
 * Other pins:
 *  - Dual auth: JWT (AuthService.getUserFromRequest) first, then
 *    NextAuth getToken fallback
 *  - hasDomains: order has any item with itemType='domain' OR no
 *    itemType (legacy fallback), AND status NOT in
 *    [cancelled, failed, terminated]
 *  - hasHosting OR-of: user.directAdminUsername set OR any
 *    hosting-itemType line in non-terminal status
 *  - hostedDomains: dedupe via Set; sourced from hosting-itemType
 *    lines with domainName present
 *  - listOrdersForUser called with { limit:0, populateUser:false,
 *    select: "domains amount status" }
 *  - Outer catch → 500 generic
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

import { GET } from "@/app/api/user/services/status/route";

function makeReq() {
  return new NextRequest(
    "https://example.com/api/user/services/status",
    { method: "GET" }
  );
}

beforeEach(() => {
  getUserFromRequest.mockReset();
  getToken.mockReset();
  getUserById.mockReset();
  listOrdersForUser.mockReset().mockResolvedValue([]);
});

describe("Dual auth — JWT first, NextAuth fallback", () => {
  it("JWT user → proceeds; NextAuth getToken NOT consulted", async () => {
    getUserFromRequest.mockResolvedValueOnce({
      _id: "U1",
      isActive: true,
      directAdminUsername: undefined,
    });
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    expect(getToken).not.toHaveBeenCalled();
  });

  it("no JWT → falls through to NextAuth; valid token + active user → 200", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    getToken.mockResolvedValueOnce({ id: "U1" });
    getUserById.mockResolvedValueOnce({ _id: "U1", isActive: true });
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
  });

  it("no JWT + no NextAuth token → 401", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    getToken.mockResolvedValue(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    expect(listOrdersForUser).not.toHaveBeenCalled();
  });

  it("NextAuth token + INACTIVE user → 401 (defence — token validity alone is not enough)", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    getToken.mockResolvedValueOnce({ id: "U1" });
    getUserById.mockResolvedValueOnce({ _id: "U1", isActive: false });
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    expect(listOrdersForUser).not.toHaveBeenCalled();
  });
});

describe("listOrdersForUser projection (anti-overfetch)", () => {
  it("called with limit:0, populateUser:false, select projection", async () => {
    getUserFromRequest.mockResolvedValueOnce({
      _id: "U1",
      isActive: true,
    });
    await GET(makeReq());
    expect(listOrdersForUser).toHaveBeenCalledWith(
      "U1",
      expect.objectContaining({
        limit: 0,
        populateUser: false,
        select: "domains amount status",
      })
    );
  });
});

describe("hasDomains flag", () => {
  function setupOrders(items: Array<{ itemType?: string; status: string; domainName?: string }>) {
    getUserFromRequest.mockResolvedValueOnce({ _id: "U1", isActive: true });
    listOrdersForUser.mockResolvedValueOnce([{ domains: items }]);
  }

  it("registered domain item → hasDomains=true", async () => {
    setupOrders([
      { itemType: "domain", status: "registered", domainName: "x.com" },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.hasDomains).toBe(true);
  });

  it("legacy item without itemType + non-terminal status → hasDomains=true (back-compat)", async () => {
    setupOrders([
      { status: "registered", domainName: "x.com" }, // no itemType
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.hasDomains).toBe(true);
  });

  it("cancelled / failed / terminated domain items → NOT counted as active", async () => {
    setupOrders([
      { itemType: "domain", status: "cancelled", domainName: "a.com" },
      { itemType: "domain", status: "failed", domainName: "b.com" },
      { itemType: "domain", status: "terminated", domainName: "c.com" },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.hasDomains).toBe(false);
  });

  it("hosting item ONLY → hasDomains=false (itemType filter)", async () => {
    setupOrders([
      { itemType: "hosting", status: "active", domainName: "x.com" },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.hasDomains).toBe(false);
  });
});

describe("hasHosting flag (OR-of two sources)", () => {
  it("user.directAdminUsername set + no hosting orders → hasHosting=true", async () => {
    getUserFromRequest.mockResolvedValueOnce({
      _id: "U1",
      isActive: true,
      directAdminUsername: "alice_da",
    });
    listOrdersForUser.mockResolvedValueOnce([]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.hasHosting).toBe(true);
  });

  it("no DA username + active hosting line item → hasHosting=true", async () => {
    getUserFromRequest.mockResolvedValueOnce({ _id: "U1", isActive: true });
    listOrdersForUser.mockResolvedValueOnce([
      {
        domains: [
          { itemType: "hosting", status: "active", domainName: "x.com" },
        ],
      },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.hasHosting).toBe(true);
  });

  it("no DA + only cancelled hosting → hasHosting=false (defensive — terminated hosting doesn't count)", async () => {
    getUserFromRequest.mockResolvedValueOnce({ _id: "U1", isActive: true });
    listOrdersForUser.mockResolvedValueOnce([
      {
        domains: [
          { itemType: "hosting", status: "cancelled", domainName: "x.com" },
        ],
      },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.hasHosting).toBe(false);
  });
});

describe("hostedDomains dedup", () => {
  it("same domain across multiple orders → returned ONCE", async () => {
    getUserFromRequest.mockResolvedValueOnce({ _id: "U1", isActive: true });
    listOrdersForUser.mockResolvedValueOnce([
      {
        domains: [
          { itemType: "hosting", status: "active", domainName: "x.com" },
        ],
      },
      {
        domains: [
          { itemType: "hosting", status: "active", domainName: "x.com" },
          { itemType: "hosting", status: "active", domainName: "y.com" },
        ],
      },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.hostedDomains.sort()).toEqual(["x.com", "y.com"]);
  });

  it("hosting line without domainName → excluded from list (no empty strings)", async () => {
    getUserFromRequest.mockResolvedValueOnce({ _id: "U1", isActive: true });
    listOrdersForUser.mockResolvedValueOnce([
      {
        domains: [
          { itemType: "hosting", status: "active" }, // no domainName
          { itemType: "hosting", status: "active", domainName: "y.com" },
        ],
      },
    ]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.hostedDomains).toEqual(["y.com"]);
  });
});

describe("Response shape", () => {
  it("returns exactly { hasDomains, hasHosting, hostedDomains } — no sensitive fields", async () => {
    getUserFromRequest.mockResolvedValueOnce({
      _id: "U1",
      isActive: true,
      directAdminUsername: "alice_da",
      password: "$2a$12$BCRYPT_LEAK",
      email: "internal@example.com",
    });
    listOrdersForUser.mockResolvedValueOnce([]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual([
      "hasDomains",
      "hasHosting",
      "hostedDomains",
    ]);
    expect(JSON.stringify(body)).not.toContain("$2a$12$BCRYPT_LEAK");
  });
});

describe("Outer catch", () => {
  it("listOrdersForUser throw → 500 generic", async () => {
    getUserFromRequest.mockResolvedValueOnce({ _id: "U1", isActive: true });
    listOrdersForUser.mockRejectedValueOnce(
      new Error("Mongo down — apk_LEAK_ME")
    );
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toContain("apk_LEAK_ME");
  });
});
