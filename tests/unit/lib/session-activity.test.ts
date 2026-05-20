/**
 * Tests for the session-activity tracker in lib/session-activity.ts.
 *
 * This is the hot path on every authenticated request: each NextAuth
 * callback (jwt, session) consults `checkSessionTimeout` and seeds Redis,
 * `updateLastActivity` writes through Redis then back-syncs to MongoDB,
 * and `rotateSession` is the "kill all this user's sessions now" lever
 * sensitive ops fire after a destructive change.
 *
 * The tracker has three failure modes worth fencing:
 *   1. Redis hot-path miss → DB cold-path must seed Redis (no infinite
 *      misses) and return the correct expiry decision.
 *   2. Tracker must never throw — even Redis + DB both down has to fail
 *      open / no-op so the request continues. Throwing here would 500
 *      every authenticated request site-wide.
 *   3. Activity-write debounce (60s) so a logged-in user spamming API
 *      calls doesn't hammer Mongo + Redis on every request.
 *
 * The tests mock @/lib/redis (the redisCache helper) and the User-service
 * helpers from @/lib/services/users that the tracker delegates to, then
 * exercise the real session-activity functions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── In-memory Redis cache stand-in ──────────────────────────────────────────
// redisCache.{get,set,del} swallow underlying errors and return null; we
// model that contract here. Individual tests can toggle `throwsOnGet` etc.
// to simulate Redis being down.
const cacheStore = new Map<string, { value: unknown; ttlSeconds: number }>();
let cacheReturnsNull = false; // simulate full Redis unavailability
const resetCache = () => {
  cacheStore.clear();
  cacheReturnsNull = false;
};

vi.mock("@/lib/redis", () => ({
  redisCache: {
    get: vi.fn(async <T>(key: string): Promise<T | null> => {
      if (cacheReturnsNull) return null;
      const entry = cacheStore.get(key);
      return (entry?.value as T | undefined) ?? null;
    }),
    set: vi.fn(async (key: string, value: unknown, ttlSeconds: number) => {
      if (cacheReturnsNull) return;
      cacheStore.set(key, { value, ttlSeconds });
    }),
    del: vi.fn(async (key: string) => {
      cacheStore.delete(key);
    }),
  },
}));

// ── User-service helpers (the tracker's DB path) ─────────────────────────────
const dbStore: Record<
  string,
  { lastActivityAt?: Date | null; sessionTimeoutMinutes?: number; role?: string }
> = {};
const dbCalls = {
  getUserSessionTimeoutFields: 0,
  updateUserLastActivity: 0,
  invalidateUserSessionNow: 0,
};

vi.mock("@/lib/services/users", () => ({
  getUserSessionTimeoutFields: vi.fn(async (userId: string) => {
    dbCalls.getUserSessionTimeoutFields += 1;
    return dbStore[userId] ?? null;
  }),
  updateUserLastActivity: vi.fn(async (userId: string, at: Date) => {
    dbCalls.updateUserLastActivity += 1;
    dbStore[userId] = { ...(dbStore[userId] ?? {}), lastActivityAt: at };
  }),
  invalidateUserSessionNow: vi.fn(async (_userId: string) => {
    dbCalls.invalidateUserSessionNow += 1;
  }),
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), log: vi.fn() },
}));

import {
  updateLastActivity,
  checkSessionTimeout,
  rotateSession,
  requiresSessionRotation,
} from "@/lib/session-activity";
import {
  ACTIVITY_UPDATE_DEBOUNCE_MS,
  DEFAULT_ADMIN_SESSION_TIMEOUT_MINUTES,
  DEFAULT_USER_SESSION_TIMEOUT_MINUTES,
} from "@/config/constants";

beforeEach(() => {
  resetCache();
  for (const key of Object.keys(dbStore)) delete dbStore[key];
  dbCalls.getUserSessionTimeoutFields = 0;
  dbCalls.updateUserLastActivity = 0;
  dbCalls.invalidateUserSessionNow = 0;
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

// ── updateLastActivity ──────────────────────────────────────────────────────

describe("updateLastActivity", () => {
  it("seeds Redis + writes DB on first call (cache miss → cold path)", async () => {
    dbStore["user-1"] = { role: "user" };

    await updateLastActivity("user-1");

    expect(cacheStore.has("session:activity:user-1")).toBe(true);
    expect(dbCalls.updateUserLastActivity).toBe(1);
    expect(dbCalls.getUserSessionTimeoutFields).toBe(1);

    // Cache should have the default user timeout (30 min) since no
    // sessionTimeoutMinutes override was set on the DB row.
    const cached = cacheStore.get("session:activity:user-1")!.value as {
      timeoutMinutes: number;
    };
    expect(cached.timeoutMinutes).toBe(DEFAULT_USER_SESSION_TIMEOUT_MINUTES);
  });

  it("uses the admin default (15 min) when role is admin", async () => {
    dbStore["admin-1"] = { role: "admin" };
    await updateLastActivity("admin-1");
    const cached = cacheStore.get("session:activity:admin-1")!.value as {
      timeoutMinutes: number;
    };
    expect(cached.timeoutMinutes).toBe(DEFAULT_ADMIN_SESSION_TIMEOUT_MINUTES);
  });

  it("honours a user-specific sessionTimeoutMinutes override", async () => {
    dbStore["user-1"] = { role: "user", sessionTimeoutMinutes: 5 };
    await updateLastActivity("user-1");
    const cached = cacheStore.get("session:activity:user-1")!.value as {
      timeoutMinutes: number;
    };
    expect(cached.timeoutMinutes).toBe(5);
  });

  it("debounces subsequent writes within the 60s window (cache hit, no DB write)", async () => {
    // Seed an activity cached just now.
    cacheStore.set("session:activity:user-1", {
      value: { lastActivityAt: Date.now(), timeoutMinutes: 30 },
      ttlSeconds: 1800,
    });
    dbCalls.updateUserLastActivity = 0;

    await updateLastActivity("user-1");

    // No DB write because we're inside the debounce window.
    expect(dbCalls.updateUserLastActivity).toBe(0);
  });

  it("writes again once the debounce window has passed", async () => {
    // Cached activity from older than ACTIVITY_UPDATE_DEBOUNCE_MS ago.
    cacheStore.set("session:activity:user-1", {
      value: {
        lastActivityAt: Date.now() - (ACTIVITY_UPDATE_DEBOUNCE_MS + 10_000),
        timeoutMinutes: 30,
      },
      ttlSeconds: 1800,
    });
    dbCalls.updateUserLastActivity = 0;

    await updateLastActivity("user-1");
    // Background DB write is fire-and-forget — give it a microtask to settle.
    await new Promise((r) => setTimeout(r, 0));

    expect(dbCalls.updateUserLastActivity).toBe(1);
  });

  it("returns silently when the user doesn't exist (no DB update, no cache seed)", async () => {
    // user not in dbStore → cold-path read returns null → function returns early.
    await updateLastActivity("ghost-user");

    expect(cacheStore.has("session:activity:ghost-user")).toBe(false);
    expect(dbCalls.updateUserLastActivity).toBe(0);
  });

  it("never throws — activity tracking must never break the request", async () => {
    // Force the User-service call to throw.
    const { getUserSessionTimeoutFields } = await import("@/lib/services/users");
    (getUserSessionTimeoutFields as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("DB down")
    );

    await expect(updateLastActivity("user-1")).resolves.toBeUndefined();
  });
});

// ── checkSessionTimeout ─────────────────────────────────────────────────────

describe("checkSessionTimeout", () => {
  it("hot path: cached activity within the window → not expired", async () => {
    cacheStore.set("session:activity:user-1", {
      value: { lastActivityAt: Date.now() - 5 * 60_000, timeoutMinutes: 30 }, // 5 min ago, 30 min window
      ttlSeconds: 1800,
    });

    const result = await checkSessionTimeout("user-1");
    expect(result.isExpired).toBe(false);
    expect(result.timeoutMinutes).toBe(30);
    // No DB round-trip on the hot path.
    expect(dbCalls.getUserSessionTimeoutFields).toBe(0);
  });

  it("hot path: cached activity past the window → expired", async () => {
    cacheStore.set("session:activity:user-1", {
      value: { lastActivityAt: Date.now() - 31 * 60_000, timeoutMinutes: 30 }, // 31 min ago, 30 min window
      ttlSeconds: 1800,
    });

    const result = await checkSessionTimeout("user-1");
    expect(result.isExpired).toBe(true);
  });

  it("cold path: cache miss → reads DB + seeds Redis for the next request", async () => {
    dbStore["user-1"] = {
      role: "user",
      sessionTimeoutMinutes: 30,
      lastActivityAt: new Date(Date.now() - 10 * 60_000), // 10 min ago
    };

    const result = await checkSessionTimeout("user-1");
    expect(result.isExpired).toBe(false);
    expect(dbCalls.getUserSessionTimeoutFields).toBe(1);
    // Cache should now be seeded — second call returns from Redis, no extra DB read.
    await checkSessionTimeout("user-1");
    expect(dbCalls.getUserSessionTimeoutFields).toBe(1);
  });

  it("cold path: DB says user doesn't exist → expired", async () => {
    const result = await checkSessionTimeout("ghost");
    expect(result.isExpired).toBe(true);
  });

  it("cold path: no recorded activity + no tokenIssuedAt → expired", async () => {
    dbStore["user-1"] = { role: "user", sessionTimeoutMinutes: 30 }; // no lastActivityAt

    const result = await checkSessionTimeout("user-1");
    expect(result.isExpired).toBe(true);
  });

  it("cold path: no recorded activity, tokenIssuedAt recent → not expired (falls back to token issue time)", async () => {
    dbStore["user-1"] = { role: "user", sessionTimeoutMinutes: 30 };
    const tokenIssuedAt = Math.floor(Date.now() / 1000) - 5 * 60; // 5 min ago

    const result = await checkSessionTimeout("user-1", tokenIssuedAt);
    expect(result.isExpired).toBe(false);
    expect(result.lastActivity).toBeInstanceOf(Date);
  });

  it("cold path: no recorded activity, tokenIssuedAt past timeout → expired", async () => {
    dbStore["user-1"] = { role: "user", sessionTimeoutMinutes: 30 };
    const tokenIssuedAt = Math.floor(Date.now() / 1000) - 60 * 60; // 1 hour ago

    const result = await checkSessionTimeout("user-1", tokenIssuedAt);
    expect(result.isExpired).toBe(true);
  });

  it("fails open when Redis throws AND DB throws (must not lock out users)", async () => {
    cacheReturnsNull = true; // Redis returns null → cold path
    const { getUserSessionTimeoutFields } = await import("@/lib/services/users");
    (getUserSessionTimeoutFields as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("DB down")
    );

    const result = await checkSessionTimeout("user-1");
    // The session-activity catch block returns `{ isExpired: false }` —
    // a Redis+DB outage must not log every user out.
    expect(result.isExpired).toBe(false);
  });

  it("uses admin default when role is admin and no sessionTimeoutMinutes override", async () => {
    dbStore["admin-1"] = {
      role: "admin",
      lastActivityAt: new Date(Date.now() - 10 * 60_000),
    };

    const result = await checkSessionTimeout("admin-1");
    expect(result.timeoutMinutes).toBe(DEFAULT_ADMIN_SESSION_TIMEOUT_MINUTES);
    // 10 min activity, 15 min admin window → not expired.
    expect(result.isExpired).toBe(false);
  });
});

// ── rotateSession ───────────────────────────────────────────────────────────

describe("rotateSession", () => {
  it("clears Redis + stamps DB sessionInvalidatedAt", async () => {
    // Seed a Redis key + DB row.
    cacheStore.set("session:activity:user-1", {
      value: { lastActivityAt: Date.now(), timeoutMinutes: 30 },
      ttlSeconds: 1800,
    });

    await rotateSession("user-1");

    expect(cacheStore.has("session:activity:user-1")).toBe(false);
    expect(dbCalls.invalidateUserSessionNow).toBe(1);
  });

  it("throws on DB error (caller must decide whether to surface or swallow)", async () => {
    // Unlike updateLastActivity / checkSessionTimeout, rotateSession is
    // called from sensitive-op handlers (DELETE user, change password)
    // where a silent rotation failure would be a security hole — the
    // caller should see the error and decide.
    const { invalidateUserSessionNow } = await import("@/lib/services/users");
    (invalidateUserSessionNow as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("DB down")
    );

    await expect(rotateSession("user-1")).rejects.toThrow("DB down");
  });
});

// ── requiresSessionRotation ─────────────────────────────────────────────────

describe("requiresSessionRotation", () => {
  // Operations confirmed in the source whitelist.
  it.each([
    ["/api/admin/users", "DELETE"],
    ["/api/admin/users/reset-password", "POST"],
    ["/api/admin/settings", "POST"],
    ["/api/admin/reset-password", "POST"],
    ["/api/user/settings", "PUT"],
    ["/api/payments", "POST"],
  ])("returns true for sensitive operation %s %s", (path, method) => {
    expect(requiresSessionRotation(path, method)).toBe(true);
  });

  it("matches paths via includes (so nested routes are caught)", () => {
    // The matcher uses .includes(op.path), so an extended path under a
    // sensitive prefix also rotates. This is the documented contract.
    expect(requiresSessionRotation("/api/admin/users/abc123", "DELETE")).toBe(true);
  });

  it("returns false for read-only operations on sensitive paths", () => {
    expect(requiresSessionRotation("/api/admin/users", "GET")).toBe(false);
    expect(requiresSessionRotation("/api/admin/settings", "GET")).toBe(false);
  });

  it("returns false for routes outside the sensitive whitelist", () => {
    expect(requiresSessionRotation("/api/domains/search", "POST")).toBe(false);
    expect(requiresSessionRotation("/api/user/dashboard", "GET")).toBe(false);
  });
});
