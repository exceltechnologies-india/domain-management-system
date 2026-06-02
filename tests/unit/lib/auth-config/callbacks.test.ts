/**
 * Tests for `@/lib/auth-config/callbacks` (rescan-4 slice 7eo).
 * NextAuth signIn / jwt / session callbacks. Pins:
 *  - **signIn social-login gate**: admin role NEVER allowed via social
 *    (Google/GitHub/Facebook) — returns false; inactive user → false;
 *    missing email from provider → false; happy-path user → true
 *  - signIn for credentials provider → always true (auth was already
 *    validated in providers.authorize)
 *  - signIn DB error on lookup → false (fail-closed for security)
 *  - **jwt token-refresh checks** (no user/account but token.id present):
 *    user not found OR isActive=false → returns null (NextAuth clears
 *    session); **sessionInvalidatedAt newer than token.iat → null**
 *    (admin "force logout user" works); session timeout → null
 *  - jwt happy-refresh: stamps token.role + token.profileCompleted from
 *    DB; **admin role gets token.passwordExpired flag** when last
 *    password change is older than PASSWORD_ROTATION_DAYS (drives
 *    forced-password-rotation banner)
 *  - jwt token-refresh DB error → does NOT invalidate token (degrade
 *    gracefully — refresh shouldn't kick everyone offline on a blip)
 *  - **session callback also validates against DB** (isActive,
 *    sessionInvalidatedAt, timeout) — returns null on any failure
 *  - session callback stamps token fields into session.user (id, role,
 *    profileCompleted, provider, optional passwordExpired)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const connectDB = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

const createUser = vi.hoisted(() => vi.fn());
const getUserByEmail = vi.hoisted(() => vi.fn());
const getUserForSessionCheck = vi.hoisted(() => vi.fn());
const getUserForTokenRefresh = vi.hoisted(() => vi.fn());
const getUserProfileCompleted = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({
  createUser,
  getUserByEmail,
  getUserForSessionCheck,
  getUserForTokenRefresh,
  getUserProfileCompleted,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const updateLastActivity = vi.hoisted(() => vi.fn());
const checkSessionTimeout = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ isExpired: false, timeoutMinutes: 30 })
);
vi.mock("@/lib/session-activity", () => ({
  updateLastActivity,
  checkSessionTimeout,
}));

vi.mock("@/config/constants", () => ({
  PASSWORD_ROTATION_DAYS: 90,
}));

vi.mock("@/lib/auth-config/helpers", () => ({
  SOCIAL_PROVIDERS: ["google", "facebook", "github"],
  extractSocialName: vi.fn().mockReturnValue({ firstName: "Alice", lastName: "Smith" }),
}));

vi.mock("@/lib/email", () => ({
  EmailService: { sendProfileCompletionEmail: vi.fn().mockResolvedValue(true) },
}));

import { callbacks } from "@/lib/auth-config/callbacks";

beforeEach(() => {
  connectDB.mockClear();
  createUser.mockReset();
  getUserByEmail.mockReset();
  getUserForSessionCheck.mockReset();
  getUserForTokenRefresh.mockReset();
  getUserProfileCompleted.mockReset();
  updateLastActivity.mockReset();
  checkSessionTimeout.mockReset();
  checkSessionTimeout.mockResolvedValue({ isExpired: false, timeoutMinutes: 30 });
});

describe("signIn callback — social-login gate", () => {
  it("admin role via social login → BLOCKED (returns false)", async () => {
    getUserByEmail.mockResolvedValueOnce({
      role: "admin",
      isActive: true,
    });
    const result = await callbacks.signIn({
      user: { email: "admin@x.test" },
      account: { provider: "google" },
      profile: {},
    } as never);
    expect(result).toBe(false);
  });

  it("inactive existing user via social → BLOCKED", async () => {
    getUserByEmail.mockResolvedValueOnce({
      role: "user",
      isActive: false,
    });
    const result = await callbacks.signIn({
      user: { email: "u@x.test" },
      account: { provider: "google" },
      profile: {},
    } as never);
    expect(result).toBe(false);
  });

  it("missing email from social provider (GitHub private email) → BLOCKED", async () => {
    const result = await callbacks.signIn({
      user: { email: null },
      account: { provider: "github" },
      profile: {},
    } as never);
    expect(result).toBe(false);
  });

  it("happy-path active user via social → true", async () => {
    getUserByEmail.mockResolvedValueOnce({
      role: "user",
      isActive: true,
    });
    const result = await callbacks.signIn({
      user: { email: "u@x.test" },
      account: { provider: "google" },
      profile: {},
    } as never);
    expect(result).toBe(true);
  });

  it("no existing user (first social login) → true (jwt will create)", async () => {
    getUserByEmail.mockResolvedValueOnce(null);
    const result = await callbacks.signIn({
      user: { email: "new@x.test" },
      account: { provider: "google" },
      profile: {},
    } as never);
    expect(result).toBe(true);
  });

  it("credentials provider → always true (auth already validated in authorize)", async () => {
    const result = await callbacks.signIn({
      user: { email: "u@x.test" },
      account: { provider: "credentials" },
      profile: {},
    } as never);
    expect(result).toBe(true);
    // No DB lookup for credentials provider.
    expect(getUserByEmail).not.toHaveBeenCalled();
  });

  it("DB lookup throw → false (fail-CLOSED for security)", async () => {
    getUserByEmail.mockRejectedValueOnce(new Error("db down"));
    const result = await callbacks.signIn({
      user: { email: "u@x.test" },
      account: { provider: "google" },
      profile: {},
    } as never);
    expect(result).toBe(false);
  });
});

describe("jwt callback — token-refresh path (no user/account, token.id present)", () => {
  it("user not found → returns null (invalidates session)", async () => {
    getUserForTokenRefresh.mockResolvedValueOnce(null);
    const result = await callbacks.jwt({
      token: { id: "U1" },
    } as never);
    expect(result).toBeNull();
  });

  it("isActive=false → null", async () => {
    getUserForTokenRefresh.mockResolvedValueOnce({ isActive: false });
    const result = await callbacks.jwt({
      token: { id: "U1" },
    } as never);
    expect(result).toBeNull();
  });

  it("sessionInvalidatedAt newer than token.iat → null (admin force-logout works)", async () => {
    getUserForTokenRefresh.mockResolvedValueOnce({
      isActive: true,
      role: "user",
      sessionInvalidatedAt: new Date("2026-06-01T12:00:00Z"),
    });
    const result = await callbacks.jwt({
      token: {
        id: "U1",
        iat: Math.floor(new Date("2026-06-01T11:00:00Z").getTime() / 1000), // before
      },
    } as never);
    expect(result).toBeNull();
  });

  it("session timeout → null", async () => {
    getUserForTokenRefresh.mockResolvedValueOnce({
      isActive: true,
      role: "user",
    });
    checkSessionTimeout.mockResolvedValueOnce({
      isExpired: true,
      timeoutMinutes: 30,
    });
    const result = await callbacks.jwt({
      token: { id: "U1", iat: 1700000000 },
    } as never);
    expect(result).toBeNull();
  });

  it("happy-refresh: stamps role + profileCompleted from DB + updates lastActivity", async () => {
    getUserForTokenRefresh.mockResolvedValueOnce({
      isActive: true,
      role: "user",
      profileCompleted: true,
    });
    const token = { id: "U1", iat: 1700000000 } as Record<string, unknown>;
    const result = await callbacks.jwt({ token } as never);
    expect((result as Record<string, unknown>).role).toBe("user");
    expect((result as Record<string, unknown>).profileCompleted).toBe(true);
    expect(updateLastActivity).toHaveBeenCalledWith("U1");
  });

  it("admin: passwordExpired TRUE when passwordChangedAt is older than PASSWORD_ROTATION_DAYS", async () => {
    const ancientChange = new Date("2024-01-01");
    getUserForTokenRefresh.mockResolvedValueOnce({
      isActive: true,
      role: "admin",
      passwordChangedAt: ancientChange,
    });
    const token = { id: "U1", iat: 1700000000 };
    const result = (await callbacks.jwt({ token } as never)) as Record<
      string,
      unknown
    >;
    expect(result.passwordExpired).toBe(true);
  });

  it("admin: passwordExpired FALSE when password was recently rotated", async () => {
    const recentChange = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // 5 days ago
    getUserForTokenRefresh.mockResolvedValueOnce({
      isActive: true,
      role: "admin",
      passwordChangedAt: recentChange,
    });
    const token = { id: "U1", iat: 1700000000 };
    const result = (await callbacks.jwt({ token } as never)) as Record<
      string,
      unknown
    >;
    expect(result.passwordExpired).toBe(false);
  });

  it("non-admin: passwordExpired is NEVER set (only admins are rotated)", async () => {
    getUserForTokenRefresh.mockResolvedValueOnce({
      isActive: true,
      role: "user",
    });
    const token = { id: "U1", iat: 1700000000 };
    const result = (await callbacks.jwt({ token } as never)) as Record<
      string,
      unknown
    >;
    expect(result.passwordExpired).toBeUndefined();
  });

  it("DB error during refresh → returns the existing token (no kicks under a DB blip)", async () => {
    getUserForTokenRefresh.mockRejectedValueOnce(new Error("transient"));
    const token = { id: "U1", iat: 1700000000 };
    const result = await callbacks.jwt({ token } as never);
    expect(result).toBe(token); // Same object, not null.
  });
});

describe("jwt callback — credentials login (user + account present)", () => {
  it("stamps token.role/id/provider + loads profileCompleted from DB", async () => {
    getUserProfileCompleted.mockResolvedValueOnce({ profileCompleted: true });
    const token = {} as Record<string, unknown>;
    const result = (await callbacks.jwt({
      token,
      user: { id: "U1", email: "u@x.test", role: "user" },
      account: { provider: "credentials" },
    } as never)) as Record<string, unknown>;
    expect(result.id).toBe("U1");
    expect(result.role).toBe("user");
    expect(result.provider).toBe("credentials");
    expect(result.profileCompleted).toBe(true);
  });
});

describe("session callback — final DB gate", () => {
  it("token absent → session passed through unchanged", async () => {
    const session = { user: { email: "u@x.test" } };
    const result = await callbacks.session({ session, token: null } as never);
    expect(result).toBe(session);
  });

  it("user not found or inactive → null (invalidates session)", async () => {
    getUserForSessionCheck.mockResolvedValueOnce(null);
    const result = await callbacks.session({
      session: { user: { email: "u@x.test" } },
      token: { id: "U1", role: "user" },
    } as never);
    expect(result).toBeNull();
  });

  it("inactive user → null", async () => {
    getUserForSessionCheck.mockResolvedValueOnce({ isActive: false });
    const result = await callbacks.session({
      session: { user: { email: "u@x.test" } },
      token: { id: "U1" },
    } as never);
    expect(result).toBeNull();
  });

  it("sessionInvalidatedAt newer than token.iat → null", async () => {
    getUserForSessionCheck.mockResolvedValueOnce({
      isActive: true,
      sessionInvalidatedAt: new Date("2026-06-01T12:00:00Z"),
    });
    const result = await callbacks.session({
      session: { user: { email: "u@x.test" } },
      token: {
        id: "U1",
        iat: Math.floor(new Date("2026-06-01T11:00:00Z").getTime() / 1000),
      },
    } as never);
    expect(result).toBeNull();
  });

  it("session timeout → null", async () => {
    getUserForSessionCheck.mockResolvedValueOnce({ isActive: true });
    checkSessionTimeout.mockResolvedValueOnce({
      isExpired: true,
      timeoutMinutes: 30,
    });
    const result = await callbacks.session({
      session: { user: { email: "u@x.test" } },
      token: { id: "U1", iat: 1700000000 },
    } as never);
    expect(result).toBeNull();
  });

  it("happy-path: stamps token fields onto session.user + role defaults to 'user' if missing", async () => {
    getUserForSessionCheck.mockResolvedValueOnce({ isActive: true });
    const session = { user: { email: "u@x.test" } } as Record<
      string,
      Record<string, unknown>
    >;
    await callbacks.session({
      session,
      token: {
        id: "U1",
        role: "admin",
        profileCompleted: true,
        provider: "credentials",
        passwordExpired: true,
        iat: 1700000000,
      },
    } as never);
    expect(session.user.id).toBe("U1");
    expect(session.user.role).toBe("admin");
    expect(session.user.profileCompleted).toBe(true);
    expect(session.user.provider).toBe("credentials");
    expect(session.user.passwordExpired).toBe(true);
  });

  it("DB throw during session check → still allows session (degrade gracefully)", async () => {
    getUserForSessionCheck.mockRejectedValueOnce(new Error("db blip"));
    const session = { user: { email: "u@x.test" } } as Record<
      string,
      Record<string, unknown>
    >;
    const result = await callbacks.session({
      session,
      token: { id: "U1", role: "user", iat: 1700000000 },
    } as never);
    expect(result).toBe(session); // Not null.
  });

  it("token.role missing → session.user.role defaults to 'user'", async () => {
    getUserForSessionCheck.mockResolvedValueOnce({ isActive: true });
    const session = { user: { email: "u@x.test" } } as Record<
      string,
      Record<string, unknown>
    >;
    await callbacks.session({
      session,
      token: { id: "U1", iat: 1700000000 },
    } as never);
    expect(session.user.role).toBe("user");
  });
});
