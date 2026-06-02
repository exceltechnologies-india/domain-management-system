/**
 * Tests for `@/lib/admin-security` exported helpers (rescan-4 slice 7ei).
 * The full verifyAdminSecurity pipeline is integration-tested elsewhere;
 * here we pin the 2 exported pure-ish helpers that callers reach for:
 *  - getClientIP: x-forwarded-for (first comma-split) > x-real-ip >
 *    request.ip > 'unknown' — same chain as audit-log (the DA layer
 *    is the OUTLIER with request.ip first)
 *  - requireReAuth: passes ONLY when bcrypt.compare(currentPassword,
 *    user.password) returns true; missing x-reauth-token header →
 *    required:true, passed:false; user-lookup failure → fail-CLOSED
 *    (required:true, passed:false); bcrypt throw → fail-CLOSED too
 *  - **fail-closed is non-negotiable** for high-stakes re-auth:
 *    a verification error MUST NOT grant access
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserWithPassword = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({
  getUserById: vi.fn(),
  getUserWithPassword,
}));

const bcryptCompare = vi.hoisted(() => vi.fn());
vi.mock("bcryptjs", () => ({
  default: { compare: bcryptCompare },
  compare: bcryptCompare,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/lib/auth-secret", () => ({ AUTH_SECRET: "test-secret" }));
vi.mock("@/lib/mongodb", () => ({ default: vi.fn() }));
vi.mock("@/lib/services/settings", () => ({
  getSetting: vi.fn(),
  getSettingValue: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimiters: { admin: { isAllowed: vi.fn() } },
}));
vi.mock("@/lib/audit-log", () => ({
  logAdminAction: vi.fn(),
  queryAuditLogs: vi.fn(),
}));
vi.mock("next-auth/jwt", () => ({ getToken: vi.fn() }));

import { getClientIP, requireReAuth } from "@/lib/admin-security";

function mockReq(opts: {
  headers?: Record<string, string>;
  ip?: string;
} = {}) {
  return {
    headers: new Headers(opts.headers ?? {}),
    ip: opts.ip,
  } as never;
}

beforeEach(() => {
  getUserWithPassword.mockReset();
  bcryptCompare.mockReset();
});

describe("getClientIP — audit-log-compatible chain (XFF first)", () => {
  it("x-forwarded-for (first comma-split) wins", () => {
    expect(
      getClientIP(
        mockReq({
          headers: {
            "x-forwarded-for": "1.1.1.1, 2.2.2.2",
            "x-real-ip": "3.3.3.3",
          },
          ip: "9.9.9.9",
        })
      )
    ).toBe("1.1.1.1");
  });

  it("x-forwarded-for first split is TRIMMED of leading whitespace", () => {
    expect(
      getClientIP(
        mockReq({ headers: { "x-forwarded-for": "  1.1.1.1  , 2.2.2.2" } })
      )
    ).toBe("1.1.1.1");
  });

  it("no XFF → x-real-ip", () => {
    expect(
      getClientIP(mockReq({ headers: { "x-real-ip": "3.3.3.3" } }))
    ).toBe("3.3.3.3");
  });

  it("no XFF + no x-real-ip → request.ip", () => {
    expect(getClientIP(mockReq({ ip: "9.9.9.9" }))).toBe("9.9.9.9");
  });

  it("nothing set → 'unknown'", () => {
    expect(getClientIP(mockReq({}))).toBe("unknown");
  });
});

describe("requireReAuth — fail-closed re-verification gate", () => {
  it("missing x-reauth-token header → required:true, passed:false", async () => {
    const result = await requireReAuth(mockReq({}), "USER_ID");
    expect(result).toEqual({ required: true, passed: false });
    expect(bcryptCompare).not.toHaveBeenCalled();
  });

  it("user not found → required:true, passed:false (fail-closed)", async () => {
    getUserWithPassword.mockResolvedValueOnce(null);
    const result = await requireReAuth(
      mockReq({ headers: { "x-reauth-token": "current-pw" } }),
      "USER_ID"
    );
    expect(result).toEqual({ required: true, passed: false });
    expect(bcryptCompare).not.toHaveBeenCalled();
  });

  it("user has no password field → fail-closed (passed:false)", async () => {
    getUserWithPassword.mockResolvedValueOnce({ password: null });
    const result = await requireReAuth(
      mockReq({ headers: { "x-reauth-token": "p" } }),
      "USER_ID"
    );
    expect(result.passed).toBe(false);
  });

  it("bcrypt.compare returns true → passed:true (the happy path)", async () => {
    getUserWithPassword.mockResolvedValueOnce({
      password: "$2a$10$validhash",
    });
    bcryptCompare.mockResolvedValueOnce(true);
    const result = await requireReAuth(
      mockReq({ headers: { "x-reauth-token": "correct-pw" } }),
      "USER_ID"
    );
    expect(result).toEqual({ required: true, passed: true });
    expect(bcryptCompare).toHaveBeenCalledWith(
      "correct-pw",
      "$2a$10$validhash"
    );
  });

  it("bcrypt.compare returns false → passed:false (wrong password)", async () => {
    getUserWithPassword.mockResolvedValueOnce({
      password: "$2a$10$hash",
    });
    bcryptCompare.mockResolvedValueOnce(false);
    const result = await requireReAuth(
      mockReq({ headers: { "x-reauth-token": "wrong-pw" } }),
      "USER_ID"
    );
    expect(result.passed).toBe(false);
  });

  it("DB throw → required:true, passed:false (fail-CLOSED — error MUST NOT grant access)", async () => {
    getUserWithPassword.mockRejectedValueOnce(new Error("db connection lost"));
    const result = await requireReAuth(
      mockReq({ headers: { "x-reauth-token": "p" } }),
      "USER_ID"
    );
    expect(result).toEqual({ required: true, passed: false });
  });

  it("bcrypt throw → fail-closed (the bcrypt-engine-broken edge case)", async () => {
    getUserWithPassword.mockResolvedValueOnce({
      password: "$2a$10$hash",
    });
    bcryptCompare.mockRejectedValueOnce(new Error("bcrypt engine broken"));
    const result = await requireReAuth(
      mockReq({ headers: { "x-reauth-token": "p" } }),
      "USER_ID"
    );
    expect(result).toEqual({ required: true, passed: false });
  });
});
