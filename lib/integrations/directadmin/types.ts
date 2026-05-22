/**
 * Anti-corruption layer for DirectAdmin responses (rescan-4 M1 slice 2,
 * 2026-05-22). Same shape as the ResellerClub layer in
 * `lib/integrations/resellerclub/` — each operation has its own typed
 * outcome union; callers switch on `kind` instead of string-matching
 * raw DA error messages.
 *
 * Migrated:
 *   - createUser  → CreateUserOutcome (with inline username-retry)
 *   - suspendUser → SuspendUserOutcome
 *
 * To migrate next:
 *   - unsuspendUser, deleteUser, modifyDomain, updateDNS
 */

/**
 * Outcome of a `createUser` call (the underlying DA API may have been
 * called more than once if the wrapper retried on username collisions —
 * see `usernameCandidates` on the input shape). Each branch maps to a
 * different upstream callsite behaviour:
 *
 * - `created`                      — DA accepted; `username` is the one
 *                                     that ultimately succeeded.
 * - `username_collision_exhausted` — tried every candidate, every one
 *                                     collided. Caller should treat as
 *                                     a hard failure (out of name
 *                                     suggestions).
 * - `da_unreachable`               — DA returned a network/5xx-class
 *                                     error (status 503 or below DA's
 *                                     ack threshold). The hosting-side
 *                                     pending-retry cron picks these
 *                                     up and retries later. `reason`
 *                                     is internal/log-only.
 * - `hard_failure`                 — anything else (package not found,
 *                                     domain rejected, validation, etc.).
 *                                     `reason` is internal/log-only;
 *                                     user sees a generic message.
 */
export type CreateUserOutcome =
  | { kind: "created"; username: string }
  | { kind: "username_collision_exhausted" }
  | { kind: "da_unreachable"; reason: string }
  | { kind: "hard_failure"; reason: string };

/**
 * Outcome of a `suspendUser` call. The four-way classification lets
 * callers (notably the expiry-worker / refund-webhook / admin-actions
 * paths) treat each scenario explicitly instead of throwing on every
 * DA error and relying on Cloud Tasks to retry.
 *
 * - `suspended`        — DA accepted the suspend (or the user was
 *                         already in the suspended state).
 * - `user_not_found`   — DA can't find the username. Means our row
 *                         points at a DA account that's been
 *                         out-of-band deleted, or was never created.
 *                         Caller should log + treat as terminal —
 *                         retrying won't help.
 * - `da_unreachable`   — DA returned a network/5xx-class error.
 *                         Caller (cron worker) should throw so Cloud
 *                         Tasks retries.
 * - `hard_failure`     — anything else (permission, validation).
 *                         Caller should throw + alert ops.
 */
export type SuspendUserOutcome =
  | { kind: "suspended" }
  | { kind: "user_not_found"; reason: string }
  | { kind: "da_unreachable"; reason: string }
  | { kind: "hard_failure"; reason: string };
