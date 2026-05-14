/**
 * Application-wide named constants.
 *
 * Centralises business-rule numbers so that changes propagate everywhere
 * without hunting for raw literals scattered across the codebase.
 */

// ── Session & Authentication ────────────────────────────────────────────────

/** Inactivity timeout (minutes) for admin accounts when no explicit value is set on the user record. */
export const DEFAULT_ADMIN_SESSION_TIMEOUT_MINUTES = 15;

/** Inactivity timeout (minutes) for regular users when no explicit value is set on the user record. */
export const DEFAULT_USER_SESSION_TIMEOUT_MINUTES = 30;

/**
 * Minimum gap between session-activity writes.
 * Requests arriving within this window reuse the cached timestamp so Redis / MongoDB
 * aren't hammered on every authenticated request.
 */
export const ACTIVITY_UPDATE_DEBOUNCE_MS = 60_000; // 1 minute

/** Number of days before an admin password is considered stale and flagged for rotation. */
export const PASSWORD_ROTATION_DAYS = 90;

// ── DNS ─────────────────────────────────────────────────────────────────────

/** Default TTL (seconds) for new DNS records — 1 hour. */
export const DNS_TTL_DEFAULT_S = 3600;

/** Minimum allowed DNS TTL (seconds). */
export const DNS_TTL_MIN_S = 300;

/** Maximum allowed DNS TTL (seconds) — 1 day. */
export const DNS_TTL_MAX_S = 86_400;

// ── Data Retention ───────────────────────────────────────────────────────────

/** How long soft-deleted domain records are kept before MongoDB TTL removes them (seconds). */
export const SOFT_DELETE_RETENTION_S = 90 * 24 * 60 * 60; // 90 days
