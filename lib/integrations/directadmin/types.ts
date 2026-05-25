/**
 * Anti-corruption layer for DirectAdmin responses (rescan-4 M1 slice 2,
 * 2026-05-22). Same shape as the ResellerClub layer in
 * `lib/integrations/resellerclub/` — each operation has its own typed
 * outcome union; callers switch on `kind` instead of string-matching
 * raw DA error messages.
 *
 * Migrated:
 *   - createUser    → CreateUserOutcome (with inline username-retry)
 *   - suspendUser   → SuspendUserOutcome
 *   - unsuspendUser → UnsuspendUserOutcome
 *   - getUserConfig → GetUserConfigOutcome
 *   - deleteUser    → DeleteUserOutcome
 *   - changePackage → ChangePackageOutcome
 *
 * Skipped (permanently disabled or not used):
 *   - updateDNSNameservers — disabled in lib/directadmin/dns.ts
 *   - modifyDomain — no callers in the codebase
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

/**
 * Outcome of an `unsuspendUser` call. Symmetric with SuspendUserOutcome
 * — same four buckets, same `user_not_found` semantics — except the
 * caller's response should be stricter: in the renewal flow we EXPECT
 * the DA account to be there, so user_not_found is a real anomaly
 * (the Hosting row references a username DA doesn't know).
 *
 * - `unsuspended`     — DA accepted (or user was already active —
 *                        unsuspend is idempotent in DA's wire form).
 * - `user_not_found`  — DA doesn't recognize the username. Renewal
 *                        callers should log at error level + still
 *                        proceed with the DB update (the customer paid).
 * - `da_unreachable`  — network/5xx. Callers usually swallow + log
 *                        since payment is already captured; the
 *                        background reconciliation handles it.
 * - `hard_failure`    — anything else; log + alert ops.
 */
export type UnsuspendUserOutcome =
  | { kind: "unsuspended" }
  | { kind: "user_not_found"; reason: string }
  | { kind: "da_unreachable"; reason: string }
  | { kind: "hard_failure"; reason: string };

/**
 * Outcome of a `getUserConfig` call (DA's CMD_API_SHOW_USER_CONFIG).
 * Read op — distinguishing user_not_found from da_unreachable is the
 * whole reason this exists. Callers like the sync-hosting-status
 * worker can mark a Hosting row terminally orphaned when the DA user
 * is genuinely gone, while still treating DA-blip errors as
 * retryable.
 *
 * - `found`           — DA returned the config map.
 * - `user_not_found`  — DA reports no such user. Hosting row points
 *                        at a deleted/never-created account.
 * - `da_unreachable`  — DA 503 / network. Caller should retry later.
 * - `hard_failure`    — anything else (permission, validation).
 */
export type GetUserConfigOutcome =
  | { kind: "found"; config: Record<string, string | undefined> }
  | { kind: "user_not_found"; reason: string }
  | { kind: "da_unreachable"; reason: string }
  | { kind: "hard_failure"; reason: string };

/**
 * Outcome of a `deleteUser` call. The cleanup workflow (diag-da and
 * admin actions) typically wants `user_not_found` to coalesce with
 * success — if we asked DA to delete a user and they don't exist,
 * the end state is what we wanted. Callers can opt into the
 * idempotent reading by collapsing both branches at the callsite.
 *
 * - `deleted`         — DA accepted the delete.
 * - `user_not_found`  — DA says the user wasn't there. For cleanup
 *                        flows this is effectively success.
 * - `da_unreachable`  — DA 503 / network. Caller should retry later.
 * - `hard_failure`    — anything else (permission, etc.).
 */
export type DeleteUserOutcome =
  | { kind: "deleted" }
  | { kind: "user_not_found"; reason: string }
  | { kind: "da_unreachable"; reason: string }
  | { kind: "hard_failure"; reason: string };

/**
 * Outcome of a `changePackage` call (DA's CMD_API_MODIFY_USER with
 * action=package). High-stakes write — payment is already captured by
 * the time we hit DA for the upgrade flow, so distinguishing "DA blip,
 * retry later" from "wrong package id, fail loudly" matters.
 *
 * - `changed`            — DA accepted the package change.
 * - `user_not_found`     — DA reports no such username. Means the
 *                           Hosting row points at a deleted/never-
 *                           created DA account.
 * - `package_not_found`  — DA reports the target package doesn't exist
 *                           on the server. Almost always a config /
 *                           seeding bug; caller should fail loudly so
 *                           ops can re-seed packages.
 * - `da_unreachable`     — 503 / network. Payment caller usually acks
 *                           the payment + queues for retry; admin
 *                           caller surfaces 503.
 * - `hard_failure`       — anything else (permission, validation).
 */
export type ChangePackageOutcome =
  | { kind: "changed" }
  | { kind: "user_not_found"; reason: string }
  | { kind: "package_not_found"; reason: string }
  | { kind: "da_unreachable"; reason: string }
  | { kind: "hard_failure"; reason: string };
