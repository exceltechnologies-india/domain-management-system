/**
 * Tests for `app/api/auth/me/route.ts` (slice 7gz, part 1). The
 * "who am I" endpoint the front-end calls on every page-load to
 * decide which UI to render.
 *
 * Critical pin: the response carries `password: <boolean>` (a flag
 * indicating whether a password exists), NOT the raw hash. The
 * route uses `userHasPassword(user._id)` so the bcrypt hash never
 * even enters this handler's scope.
 *
 * Pins:
 *  - connectDB BEFORE auth
 *  - Dual-auth: AuthService.getUserFromRequest first; on null,
 *    fall back to getToken (NextAuth session) → getUserById +
 *    isActive check
 *  - getUserById returns user but !isActive → 401 (deactivated
 *    account with a still-valid JWT must NOT see the data)
 *  - Both auth paths empty → 401 'Not authenticated' UNAUTHORIZED
 *  - **password is BOOLEAN, NOT the hash**: userHasPassword called
 *    with user._id and its return value is what reaches the
 *    response under `password` field
 *  - profileCompleted strict-true normalisation: undefined / null
 *    / any non-true value → false in response
 *  - Curated field set in response (id/email/firstName/lastName/
 *    role/isActivated/isActive/profileCompleted/provider/password/
 *    phone/phoneCc/companyName/address)
 *  - Outer catch → 500 INTERNAL_ERROR generic
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const getToken = vi.hoisted(() => vi.fn());
vi.mock("next-auth/jwt", () => ({ getToken }));
vi.mock("@/lib/auth-secret", () => ({ AUTH_SECRET: "test-secret" }));

const connectDB = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

const getUserById = vi.hoisted(() => vi.fn());
const userHasPassword = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserById, userHasPassword }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/auth/me/route";

function makeReq() {
  return new NextRequest("https://example.com/api/auth/me", { method: "GET" });
}

const fullUser = {
  _id: "U1",
  email: "alice@example.com",
  firstName: "Alice",
  lastName: "Anderson",
  role: "user",
  isActivated: true,
  isActive: true,
  profileCompleted: true,
  provider: "credentials",
  phone: "1234567890",
  phoneCc: "+91",
  companyName: "Anutech",
  address: "Mumbai",
};

beforeEach(() => {
  getUserFromRequest.mockReset();
  getToken.mockReset();
  connectDB.mockClear().mockResolvedValue(undefined);
  getUserById.mockReset();
  userHasPassword.mockReset().mockResolvedValue(true);
});

describe("connectDB before auth", () => {
  it("connectDB runs first; on both-auth-fail returns 401 — DB still called", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    getToken.mockResolvedValueOnce(null);
    await GET(makeReq());
    expect(connectDB).toHaveBeenCalled();
  });
});

describe("Auth — primary path", () => {
  it("AuthService returns user → no JWT fallback", async () => {
    getUserFromRequest.mockResolvedValueOnce(fullUser);
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    expect(getToken).not.toHaveBeenCalled();
  });
});

describe("Auth — JWT fallback", () => {
  it("AuthService null + token.id present + active user → proceeds", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    getToken.mockResolvedValueOnce({ id: "U-JWT" });
    getUserById.mockResolvedValueOnce({ ...fullUser, _id: "U-JWT", isActive: true });
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    expect(getUserById).toHaveBeenCalledWith("U-JWT");
  });

  it("getToken resolved but user.isActive=false → 401 (deactivated with valid JWT)", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    getToken.mockResolvedValueOnce({ id: "U-DEAD" });
    getUserById.mockResolvedValueOnce({ ...fullUser, isActive: false });

    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
    expect(userHasPassword).not.toHaveBeenCalled();
  });

  it("getToken resolved but getUserById null → 401", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    getToken.mockResolvedValueOnce({ id: "U-DELETED" });
    getUserById.mockResolvedValueOnce(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  it("no AuthService + no token at all → 401 'Not authenticated'", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    getToken.mockResolvedValueOnce(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Not authenticated");
  });
});

describe("password field is BOOLEAN not hash", () => {
  it("userHasPassword called with user._id; its boolean return value lands in response.password", async () => {
    getUserFromRequest.mockResolvedValueOnce(fullUser);
    userHasPassword.mockResolvedValueOnce(true);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(userHasPassword).toHaveBeenCalledWith("U1");
    expect(body.user.password).toBe(true);
    expect(typeof body.user.password).toBe("boolean");
  });

  it("returns false for Google-OAuth-only accounts (no password)", async () => {
    getUserFromRequest.mockResolvedValueOnce(fullUser);
    userHasPassword.mockResolvedValueOnce(false);
    const body = await (await GET(makeReq())).json();
    expect(body.user.password).toBe(false);
  });

  it("source user.password (hash) MUST NOT leak through — test injects a fake hash and asserts it's absent", async () => {
    getUserFromRequest.mockResolvedValueOnce({
      ...fullUser,
      // Imagine the model accidentally returned the hash here:
      password: "$2a$12$BCRYPT_HASH_LEAK_ME_LEAK_ME_LEAK",
    });
    userHasPassword.mockResolvedValueOnce(true);
    const body = await (await GET(makeReq())).json();
    expect(body.user.password).toBe(true); // boolean, not hash
    const json = JSON.stringify(body);
    expect(json).not.toContain("BCRYPT_HASH_LEAK");
    expect(json).not.toContain("$2a$12$");
  });
});

describe("profileCompleted strict-true normalisation", () => {
  it("profileCompleted === true → response true", async () => {
    getUserFromRequest.mockResolvedValueOnce({ ...fullUser, profileCompleted: true });
    const body = await (await GET(makeReq())).json();
    expect(body.user.profileCompleted).toBe(true);
  });

  it.each([false, undefined, null, 1, "true"])(
    "profileCompleted = %p → response false (strict-true required)",
    async (val) => {
      getUserFromRequest.mockResolvedValueOnce({
        ...fullUser,
        profileCompleted: val as never,
      });
      const body = await (await GET(makeReq())).json();
      expect(body.user.profileCompleted).toBe(false);
    }
  );
});

describe("Curated response shape", () => {
  it("returns the documented field set; internal fields NOT included", async () => {
    getUserFromRequest.mockResolvedValueOnce({
      ...fullUser,
      // Internal fields injected to confirm they don't leak
      totpSecret: "JBSWY3DPEHPK3PXP",
      hostingExpiresAt: new Date("2027-01-01"),
      sessionInvalidatedAt: new Date("2026-06-10"),
      directAdminUsername: "alice_da",
      pendingEmail: "next@example.com",
    });
    userHasPassword.mockResolvedValueOnce(true);
    const body = await (await GET(makeReq())).json();
    expect(body.user).toEqual({
      id: "U1",
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Anderson",
      role: "user",
      isActivated: true,
      isActive: true,
      profileCompleted: true,
      provider: "credentials",
      password: true,
      phone: "1234567890",
      phoneCc: "+91",
      companyName: "Anutech",
      address: "Mumbai",
    });
    const json = JSON.stringify(body);
    expect(json).not.toContain("JBSWY3DPEHPK3PXP");
    expect(json).not.toContain("directAdminUsername");
    expect(json).not.toContain("sessionInvalidatedAt");
    expect(json).not.toContain("pendingEmail");
  });
});

describe("Outer catch", () => {
  it("connectDB throw → 500 INTERNAL_ERROR 'Internal server error'", async () => {
    connectDB.mockRejectedValueOnce(new Error("Mongo timeout"));
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.error).toBe("Internal server error");
  });
});
