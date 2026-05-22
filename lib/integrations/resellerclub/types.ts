/**
 * Anti-corruption layer for ResellerClub responses (rescan-4 M1, 2026-05-22).
 *
 * The raw ResellerClubResponse from `lib/resellerclub` carries a loose
 * `{status, message, data}` shape — callers used to branch on
 * `result.status === "success"` and `result.message.toLowerCase().includes("insufficient balance")`
 * to make sense of it. That worked but coupled every callsite to the
 * upstream wire format and to specific English-language fragments. Any RC
 * wording change silently flips success ↔ failed.
 *
 * The types here normalise raw RC responses into typed discriminated
 * unions so callers `switch (outcome.kind)` instead. Each operation has
 * its own outcome type (no unionising everything into one mega-shape)
 * since each operation has its own meaningful states.
 *
 * Migrated:
 *   - registerDomain → RegisterDomainOutcome
 *   - renewDomain    → RenewDomainOutcome
 *
 * To migrate next (follow-up batches):
 *   - getDomainOrderId, getDomainDetails, getDNSRecords, transferDomain;
 *     DirectAdmin: suspendUser, modifyDomain, updateDNS, getUserConfig.
 */

/**
 * Outcome of a `registerDomain` call. Replaces the previous pattern of
 * branching on `result.status` + 7 different `toLowerCase().includes(...)`
 * substring checks against `result.message`.
 *
 * - `registered`            — RC accepted + returned an orderId.
 * - `registered_no_order_id` — RC accepted but didn't echo orderId (real
 *                              quirk; caller does a fallback `getDomainOrderId`).
 * - `balance_pending`       — registration is queued on RC's side because
 *                              of insufficient balance / credit-limit /
 *                              low-funds. Auto-resolves when ops tops up.
 * - `already_in_progress`   — duplicate registration or pre-existing
 *                              pending order for the same name. Treat
 *                              similarly to `balance_pending` — admin
 *                              follow-up but not a user-facing error.
 * - `hard_failure`          — truly failed (TLD validation, locked domain,
 *                              contact-data rejection, etc.). `reason` is
 *                              internal/log-only — never echo to the user.
 */
export type RegisterDomainOutcome =
  | { kind: "registered"; orderId: string }
  | { kind: "registered_no_order_id" }
  | { kind: "balance_pending" }
  | { kind: "already_in_progress" }
  | { kind: "hard_failure"; reason: string };

/**
 * Outcome of a `renewDomain` call. The wrapper does the order-id +
 * expiry-date pre-flight lookups inline (previously in
 * `ResellerClubWrapper.renewDomain`) and folds those failures into this
 * single outcome.
 *
 * - `renewed`         — RC accepted the renewal. `orderId` / `price`
 *                       carried through from the response when present.
 * - `balance_pending` — RC queued the renewal pending reseller-account
 *                       top-up (same fragments class as registerDomain).
 * - `hard_failure`    — anything else (order-id lookup failed, expiry
 *                       lookup failed, registry rejected, etc.).
 *                       `reason` is internal-only.
 */
export type RenewDomainOutcome =
  | { kind: "renewed"; orderId?: string; price?: number }
  | { kind: "balance_pending" }
  | { kind: "hard_failure"; reason: string };
