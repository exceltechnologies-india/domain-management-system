/**
 * Anti-corruption layer for DirectAdmin responses (rescan-4 M1 slice 2,
 * 2026-05-22). Same shape as the ResellerClub layer in
 * `lib/integrations/resellerclub/` — each operation has its own typed
 * outcome union; callers switch on `kind` instead of string-matching
 * raw DA error messages.
 *
 * Migrated:
 *   - createUser → CreateUserOutcome (with inline username-retry)
 *
 * To migrate next:
 *   - suspendUser, unsuspendUser, deleteUser, modifyDomain, updateDNS
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
