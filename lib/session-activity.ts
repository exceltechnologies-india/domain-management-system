/**
 * Session Activity Tracking and Timeout Management
 *
 * Hot path (every authenticated request): Redis-first.
 * Redis key `session:activity:{userId}` holds { lastActivityAt, timeoutMinutes }
 * with a TTL equal to the session timeout — key expiry IS session expiry.
 *
 * Cold path (cache miss): falls back to DB and re-seeds the cache so the
 * next request is served from Redis again.
 *
 * Redis unavailability is tolerated: redisCache helpers swallow errors and
 * return null, which causes automatic fallback to DB.
 */

import { serverLogger } from "@/lib/server-logger";
import { redisCache } from "@/lib/redis";
import {
  getUserSessionTimeoutFields,
  invalidateUserSessionNow,
  updateUserLastActivity,
} from "@/lib/services/users";
import {
  ACTIVITY_UPDATE_DEBOUNCE_MS,
  DEFAULT_ADMIN_SESSION_TIMEOUT_MINUTES,
  DEFAULT_USER_SESSION_TIMEOUT_MINUTES,
} from "@/config/constants";

interface CachedActivity {
  lastActivityAt: number; // Unix ms
  timeoutMinutes: number;
}

const activityKey = (userId: string) => `session:activity:${userId}`;

/**
 * Update the user's last-activity timestamp.
 * Redis is written immediately; MongoDB is synced in the background (non-blocking).
 * Skips the update entirely if activity was recorded less than 60 seconds ago
 * (reduces write pressure on both Redis and MongoDB).
 */
export async function updateLastActivity(userId: string): Promise<void> {
  try {
    const key = activityKey(userId);
    const now = Date.now();

    const cached = await redisCache.get<CachedActivity>(key);

    if (cached) {
      // Skip if refreshed within the last minute
      if (now - cached.lastActivityAt < ACTIVITY_UPDATE_DEBOUNCE_MS) return;

      const updated: CachedActivity = {
        lastActivityAt: now,
        timeoutMinutes: cached.timeoutMinutes,
      };
      await redisCache.set(key, updated, cached.timeoutMinutes * 60);

      // Background DB sync — non-blocking so it never delays the response
      updateUserLastActivity(userId, new Date(now)).catch((e) =>
        serverLogger.error("[session-activity] DB sync error:", e)
      );

      return;
    }

    // Cache miss: read from DB to discover the user's timeout, then seed cache
    const user = await getUserSessionTimeoutFields(userId);
    if (!user) return;

    const timeoutMinutes =
      user.sessionTimeoutMinutes ||
      (user.role === "admin"
        ? DEFAULT_ADMIN_SESSION_TIMEOUT_MINUTES
        : DEFAULT_USER_SESSION_TIMEOUT_MINUTES);

    await Promise.all([
      redisCache.set(
        key,
        { lastActivityAt: now, timeoutMinutes } satisfies CachedActivity,
        timeoutMinutes * 60
      ),
      updateUserLastActivity(userId, new Date(now)),
    ]);
  } catch (error) {
    serverLogger.error("[session-activity] updateLastActivity error:", error);
    // Never throw — activity tracking must not break the request
  }
}

/**
 * Check whether the session has timed out due to inactivity.
 *
 * Returns immediately from Redis on the hot path (no DB round-trip).
 * On cache miss, reads from DB and re-seeds the cache for subsequent requests.
 */
export async function checkSessionTimeout(
  userId: string,
  tokenIssuedAt?: number
): Promise<{
  isExpired: boolean;
  timeoutMinutes?: number;
  lastActivity?: Date;
  timeRemaining?: number;
}> {
  try {
    const key = activityKey(userId);

    // ── Hot path: Redis ──────────────────────────────────────────────────────
    const cached = await redisCache.get<CachedActivity>(key);

    if (cached) {
      const minutesSince =
        (Date.now() - cached.lastActivityAt) / (1000 * 60);
      const timeRemaining = Math.max(0, cached.timeoutMinutes - minutesSince);

      return {
        isExpired: timeRemaining <= 0,
        timeoutMinutes: cached.timeoutMinutes,
        lastActivity: new Date(cached.lastActivityAt),
        timeRemaining,
      };
    }

    // ── Cold path: DB fallback ───────────────────────────────────────────────
    const user = await getUserSessionTimeoutFields(userId);

    if (!user) return { isExpired: true };

    const timeoutMinutes =
      user.sessionTimeoutMinutes ||
      (user.role === "admin"
        ? DEFAULT_ADMIN_SESSION_TIMEOUT_MINUTES
        : DEFAULT_USER_SESSION_TIMEOUT_MINUTES);
    const lastActivity: Date | null = user.lastActivityAt ?? null;

    // No recorded activity — fall back to the token's issue time
    if (!lastActivity) {
      if (tokenIssuedAt) {
        const tokenDate = new Date(tokenIssuedAt * 1000);
        const minutesSince =
          (Date.now() - tokenDate.getTime()) / (1000 * 60);
        const isExpired = minutesSince > timeoutMinutes;
        const timeRemaining = Math.max(0, timeoutMinutes - minutesSince);

        if (!isExpired) {
          await redisCache.set(
            key,
            { lastActivityAt: tokenDate.getTime(), timeoutMinutes } satisfies CachedActivity,
            Math.ceil(timeRemaining * 60)
          );
        }

        return { isExpired, timeoutMinutes, lastActivity: tokenDate, timeRemaining };
      }
      return { isExpired: true, timeoutMinutes };
    }

    const minutesSince =
      (Date.now() - lastActivity.getTime()) / (1000 * 60);
    const isExpired = minutesSince > timeoutMinutes;
    const timeRemaining = Math.max(0, timeoutMinutes - minutesSince);

    // Re-seed cache so the next request is served from Redis
    if (!isExpired) {
      await redisCache.set(
        key,
        { lastActivityAt: lastActivity.getTime(), timeoutMinutes } satisfies CachedActivity,
        Math.ceil(timeRemaining * 60)
      );
    }

    return { isExpired, timeoutMinutes, lastActivity, timeRemaining };
  } catch (error) {
    serverLogger.error("[session-activity] checkSessionTimeout error:", error);
    // Fail open — a Redis/DB error must not log out legitimate users
    return { isExpired: false };
  }
}

/**
 * Rotate the session by invalidating it immediately.
 * Clears the Redis key so the next request cannot be served stale data.
 */
export async function rotateSession(userId: string): Promise<void> {
  try {
    await Promise.all([
      redisCache.del(activityKey(userId)),
      invalidateUserSessionNow(userId),
    ]);
  } catch (error) {
    serverLogger.error("[session-activity] rotateSession error:", error);
    throw error;
  }
}

/**
 * Check if an operation requires session rotation.
 */
export function requiresSessionRotation(
  path: string,
  method: string
): boolean {
  const sensitiveOperations = [
    { path: "/api/admin/users", method: "DELETE" },
    { path: "/api/admin/users/reset-password", method: "POST" },
    { path: "/api/admin/settings", method: "POST" },
    { path: "/api/admin/reset-password", method: "POST" },
    { path: "/api/user/settings", method: "PUT" },
    { path: "/api/payments", method: "POST" },
  ];

  return sensitiveOperations.some(
    (op) => path.includes(op.path) && method === op.method
  );
}
