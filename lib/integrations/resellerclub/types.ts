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
 *   - registerDomain    → RegisterDomainOutcome
 *   - renewDomain       → RenewDomainOutcome
 *   - transferDomain    → TransferDomainOutcome
 *   - getDomainOrderId  → GetDomainOrderIdOutcome
 *   - getDomainDetails  → GetDomainDetailsOutcome
 *   - getDNSRecords     → GetDNSRecordsOutcome
 *
 * To migrate next (follow-up batches):
 *   - DirectAdmin: modifyDomain (updateDNSNameservers permanently disabled).
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

/**
 * Outcome of a `transferDomain` call. RC kicks off the registry transfer
 * asynchronously — the user-facing flow needs to communicate "transfer
 * started, will complete in N days at the gaining registry" rather than
 * synchronous success.
 *
 * - `transfer_initiated`     — RC accepted the request; `entityId` is
 *                               the RC-side tracking id (sometimes called
 *                               orderId elsewhere).
 * - `balance_pending`        — same reseller-account-balance fragments
 *                               that affect register/renew.
 * - `transfer_rejected`      — registry rejected (bad EPP code, domain
 *                               locked, transfer-prohibited status,
 *                               within 60d of registration, etc.).
 *                               `reason` is internal/log-only; the user
 *                               sees a generic "transfer rejected" copy.
 * - `hard_failure`           — anything else (RC API error, network).
 *                               Same generic-message handling.
 */
export type TransferDomainOutcome =
  | { kind: "transfer_initiated"; entityId?: string }
  | { kind: "balance_pending" }
  | { kind: "transfer_rejected"; reason: string }
  | { kind: "hard_failure"; reason: string };

/**
 * Outcome of a `getDomainOrderId` call (RC `/api/domains/orderid.json`).
 *
 * Used as a pre-flight by renewal / cleanup / sync workflows that need
 * the RC-side order-id to act on a domain. The interesting distinction
 * is `not_found` (RC says no such order on our reseller account — this
 * is a real signal during admin cleanup and during pending-domain
 * cancellation) vs `hard_failure` (network blip, RC outage, etc.).
 *
 * - `found`         — RC returned an order-id; `orderId` is non-empty.
 * - `not_found`     — RC reports no matching order. Callers like
 *                      admin pending-domain delete treat this as "no
 *                      registrar-side cancellation needed".
 * - `hard_failure`  — network/RC error. `reason` is internal/log-only.
 */
export type GetDomainOrderIdOutcome =
  | { kind: "found"; orderId: string }
  | { kind: "not_found"; reason: string }
  | { kind: "hard_failure"; reason: string };

/**
 * Loose shape of the RC `/api/domains/details.json` response data.
 * Fields are not all present in every response — callers should
 * defensively check before parsing.
 */
export interface DomainDetailsRecord {
  endtime?: string;
  creationtime?: string;
  currentstatus?: string;
  domainstatus?: string;
  ns?: string[];
  // RC also returns several other fields (entityid, productkey, etc.)
  // — preserved on the underlying object but not typed here.
  [k: string]: unknown;
}

/**
 * Outcome of a `getDomainDetails` call (RC `/api/domains/details.json`).
 *
 * Read op — distinguishing `not_found` from `hard_failure` lets the
 * verify-status route (and DomainVerificationService.syncDomainWithRegistrar)
 * map "RC has no record of this domain" onto a meaningful UI state
 * (likely pending registration) rather than a generic 500.
 *
 * - `found`         — RC returned the details record.
 * - `not_found`     — RC reports no such domain on our reseller
 *                      account.
 * - `hard_failure`  — network/RC error. `reason` is internal/log-only.
 */
export type GetDomainDetailsOutcome =
  | { kind: "found"; details: DomainDetailsRecord }
  | { kind: "not_found"; reason: string }
  | { kind: "hard_failure"; reason: string };

/**
 * Normalised DNS record shape callers see after the inner wrapper in
 * `lib/resellerclub/dns.ts` has merged RC's various field aliases
 * (recordid / recordId / record-id, timetolive / ttl, host / name).
 * Keeps the underlying RC fields available via the index signature.
 */
export interface DnsRecordEntry {
  type?: string;
  value?: string;
  id?: string;
  ttl?: string | number;
  name?: string;
  priority?: string | number;
  [k: string]: unknown;
}

/**
 * Outcome of a `getDNSRecords` call (RC fans out one
 * `/api/dns/manage/search-records.json` per record type and merges).
 *
 * - `found`         — RC returned records (possibly empty array).
 * - `not_found`     — domain isn't under our DNS management /
 *                      doesn't exist on RC. Callers map to a 404.
 * - `hard_failure`  — network / RC error. Callers map to 500.
 */
export type GetDNSRecordsOutcome =
  | { kind: "found"; records: DnsRecordEntry[] }
  | { kind: "not_found"; reason: string }
  | { kind: "hard_failure"; reason: string };
