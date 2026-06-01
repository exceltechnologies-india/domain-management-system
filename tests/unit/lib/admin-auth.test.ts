/**
 * Tests for `@/lib/admin-auth` (rescan-4 slice 7eh).
 * verifyAdminAuth + verifyUserAuth — JWT-based admin/user gating. Pins:
 *  - no `token` cookie → valid:false + 'No authentication token' message
 *  - jwt.verify throws → valid:false + generic 'Invalid or expired' (the
 *    actual error message NEVER leaks to the client — defense vs token
 *    enumeration)
 *  - decoded.userId missing → valid:false 'Invalid token format'
 *  - getUserById returns null → 'User not found'
 *  - user.isActive=false → admin: error 'Account is deactivated';
 *    USER variant ALSO sets `message` with support email + isDeactivated:true
 *    (drives the client-side 'contact support' banner)
 *  - admin: user.role !== 'admin' → 'Access denied. Admin privileges required.'
 *  - admin happy-path: logs an admin-action audit entry via `void` (non-blocking)
 *    with the right userId/email/action/method/path/ip
 *  - admin returns sanitised user shape (id, email, firstName, lastName, role) —
 *    NEVER the password hash or token state
 *  - getClientIP precedence: x-forwarded-for (first comma-split) > x-real-ip >
 *    request.ip > 'unknown' (same chain as audit-log)
 *  - USER variant uses SUPPORT_EMAIL env, falls back to 'support@anutech.in'
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const jwtVerify = vi.hoisted(() => vi.fn());
vi.mock("jsonwebtoken", () => ({ default: { verify: jwtVerify }, verify: jwtVerify }));

const connectDB = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

const getUserById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserById }));

const logAdminAction = vi.hoisted(() => vi.fn());
vi.mock("@/lib/audit-log", () => ({ logAdminAction }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/lib/auth-secret", () => ({
  AUTH_SECRET: "test-jwt-secret",
}));

import { verifyAdminAuth, verifyUserAuth } from "@/lib/admin-auth";

function mockReq(opts: {
  token?: string;
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  searchParams?: Record<string, string>;
}) {
  const headers = new Headers(opts.headers ?? {});
  const cookies = new Map<string, { value: string }>();
  if (opts.token) cookies.set("token", { value: opts.token });
  return {
    cookies: {
      get: (name: string) => cookies.get(name),
    },
    headers,
    method: opts.method ?? "GET",
    nextUrl: {
      pathname: opts.path ?? "/api/admin/users",
      searchParams: new URLSearchParams(opts.searchParams ?? {}),
    },
  } as never;
}

const ADMIN = {
  _id: { toString: () => "ADMIN_ID" },
  email: "admin@x.test",
  firstName: "A",
  lastName: "Min",
  role: "admin",
  isActive: true,
};

const REGULAR_USER = {
  _id: { toString: () => "USER_ID" },
  email: "user@x.test",
  firstName: "U",
  lastName: "Ser",
  role: "user",
  isActive: true,
};

beforeEach(() => {
  jwtVerify.mockReset();
  connectDB.mockReset();
  getUserById.mockReset();
  logAdminAction.mockReset();
});

describe("verifyAdminAuth", () => {
  it("no token cookie → valid:false 'No authentication token'", async () => {
    const result = await verifyAdminAuth(mockReq({}));
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/No authentication token/);
  });

  it("jwt.verify throws → valid:false with GENERIC 'Invalid or expired' (never leaks JWT error)", async () => {
    jwtVerify.mockImplementationOnce(() => {
      throw new Error("JsonWebTokenError: invalid signature");
    });
    const result = await verifyAdminAuth(mockReq({ token: "bad-token" }));
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid or expired authentication token");
    // Generic message — internal jwt error MUST NOT leak.
    expect(result.error).not.toMatch(/JsonWebTokenError|signature/);
  });

  it("decoded payload missing userId → 'Invalid token format'", async () => {
    jwtVerify.mockReturnValueOnce({});
    const result = await verifyAdminAuth(mockReq({ token: "t" }));
    expect(result.error).toBe("Invalid token format");
  });

  it("user not in DB → 'User not found'", async () => {
    jwtVerify.mockReturnValueOnce({ userId: "u1" });
    getUserById.mockResolvedValueOnce(null);
    const result = await verifyAdminAuth(mockReq({ token: "t" }));
    expect(result.error).toBe("User not found");
  });

  it("user.isActive=false → 'Account is deactivated'", async () => {
    jwtVerify.mockReturnValueOnce({ userId: "u1" });
    getUserById.mockResolvedValueOnce({ ...ADMIN, isActive: false });
    const result = await verifyAdminAuth(mockReq({ token: "t" }));
    expect(result.error).toBe("Account is deactivated");
  });

  it("user.role !== 'admin' → 'Access denied'", async () => {
    jwtVerify.mockReturnValueOnce({ userId: "u1" });
    getUserById.mockResolvedValueOnce(REGULAR_USER);
    const result = await verifyAdminAuth(mockReq({ token: "t" }));
    expect(result.error).toMatch(/Admin privileges required/);
  });

  it("happy path: returns sanitised user + logs admin-action audit entry (fire-and-forget)", async () => {
    jwtVerify.mockReturnValueOnce({ userId: "u1" });
    getUserById.mockResolvedValueOnce(ADMIN);
    const req = mockReq({
      token: "t",
      method: "DELETE",
      path: "/api/admin/users/del",
      headers: { "x-forwarded-for": "1.2.3.4", "user-agent": "test-UA" },
    });
    const result = await verifyAdminAuth(req);
    expect(result.valid).toBe(true);
    expect(result.user).toEqual({
      id: "ADMIN_ID",
      email: "admin@x.test",
      firstName: "A",
      lastName: "Min",
      role: "admin",
    });
    // Audit-action log entry.
    expect(logAdminAction).toHaveBeenCalled();
    const entry = logAdminAction.mock.calls[0][0];
    expect(entry.action).toBe("DELETE_DEL");
    expect(entry.method).toBe("DELETE");
    expect(entry.ip).toBe("1.2.3.4");
    expect(entry.userAgent).toBe("test-UA");
    expect(entry.success).toBe(true);
  });

  it("audit-log IP precedence: XFF (first split) > x-real-ip > req.ip > 'unknown'", async () => {
    jwtVerify.mockReturnValue({ userId: "u1" });
    getUserById.mockResolvedValue(ADMIN);

    await verifyAdminAuth(
      mockReq({
        token: "t",
        headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" },
      })
    );
    expect(logAdminAction.mock.calls[0][0].ip).toBe("1.1.1.1");

    logAdminAction.mockReset();
    await verifyAdminAuth(
      mockReq({
        token: "t",
        headers: { "x-real-ip": "3.3.3.3" },
      })
    );
    expect(logAdminAction.mock.calls[0][0].ip).toBe("3.3.3.3");

    logAdminAction.mockReset();
    await verifyAdminAuth(mockReq({ token: "t" }));
    expect(logAdminAction.mock.calls[0][0].ip).toBe("unknown");
  });
});

describe("verifyUserAuth", () => {
  it("no token → 'No authentication token'", async () => {
    const result = await verifyUserAuth(mockReq({}));
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/No authentication token/);
  });

  it("user.isActive=false: enriched with 'contact support' banner fields (drives UI)", async () => {
    jwtVerify.mockReturnValueOnce({ userId: "u1" });
    getUserById.mockResolvedValueOnce({ ...REGULAR_USER, isActive: false });
    vi.stubEnv("SUPPORT_EMAIL", "help@anutech.in");
    const result = await verifyUserAuth(mockReq({ token: "t" }));
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Account is deactivated");
    expect(result.message).toContain("help@anutech.in");
    expect(result.message).toContain("deactivated");
    expect(result.supportEmail).toBe("help@anutech.in");
    expect(result.isDeactivated).toBe(true);
    vi.unstubAllEnvs();
  });

  it("SUPPORT_EMAIL unset → falls back to 'support@anutech.in'", async () => {
    jwtVerify.mockReturnValueOnce({ userId: "u1" });
    getUserById.mockResolvedValueOnce({ ...REGULAR_USER, isActive: false });
    vi.stubEnv("SUPPORT_EMAIL", "");
    const result = await verifyUserAuth(mockReq({ token: "t" }));
    expect(result.supportEmail).toBe("support@anutech.in");
    vi.unstubAllEnvs();
  });

  it("happy path: allows non-admin users (unlike verifyAdminAuth) + returns sanitised user", async () => {
    jwtVerify.mockReturnValueOnce({ userId: "u1" });
    getUserById.mockResolvedValueOnce(REGULAR_USER);
    const result = await verifyUserAuth(mockReq({ token: "t" }));
    expect(result.valid).toBe(true);
    expect(result.user?.role).toBe("user");
  });

  it("jwt.verify throws → generic 'Invalid or expired' (no leak)", async () => {
    jwtVerify.mockImplementationOnce(() => {
      throw new Error("TokenExpiredError: jwt expired");
    });
    const result = await verifyUserAuth(mockReq({ token: "t" }));
    expect(result.error).toBe("Invalid or expired authentication token");
    expect(result.error).not.toMatch(/TokenExpiredError/);
  });

  it("does NOT call logAdminAction (only admin path audits)", async () => {
    jwtVerify.mockReturnValueOnce({ userId: "u1" });
    getUserById.mockResolvedValueOnce(REGULAR_USER);
    await verifyUserAuth(mockReq({ token: "t" }));
    expect(logAdminAction).not.toHaveBeenCalled();
  });
});
