/**
 * Pure response-classification for `registerDomain`. Extracted from
 * `register-domain.ts` so it can be unit-tested in isolation — the
 * registerDomain wrapper itself imports the heavy ResellerClubWrapper
 * module, which throws at module load when its env vars are missing
 * (test envs don't set them).
 */
import type { ResellerClubResponse } from "@/lib/types";
import type {
  RegisterDomainOutcome,
  RenewDomainOutcome,
  TransferDomainOutcome,
  GetDomainOrderIdOutcome,
  GetDomainDetailsOutcome,
  GetDNSRecordsOutcome,
  DomainDetailsRecord,
  DnsRecordEntry,
} from "./types";

/**
 * Substring fragments RC's error messages use when registration is
 * deferred for balance / credit reasons. Shared with the inner-layer
 * `lib/resellerclub/registration.ts` so both classification points
 * agree on the vocabulary.
 */
export const BALANCE_PENDING_FRAGMENTS = [
  "insufficient balance",
  "low funds",
  "insufficient funds",
  "account balance",
  "credit limit",
  // RC sometimes wraps a balance issue in a generic support-contact
  // message without naming the underlying cause — treat as pending so
  // the auto-retry cron has a chance to drain it.
  "please contact support",
] as const;

/**
 * Substring fragments RC returns when the registration is queued for
 * registry processing (lock contention, racing reseller orders, etc.).
 * Most clear on their own — same semantics as balance-pending from the
 * caller's POV.
 */
export const PROCESSING_LOCK_FRAGMENTS = [
  "order locked for processing",
  "locked for processing",
  "processing",
] as const;

/**
 * Substring fragments RC returns when the same name is already in flight
 * (duplicate or pending order on our reseller account).
 */
export const ALREADY_IN_PROGRESS_FRAGMENTS = [
  "already exists in our database",
  "pending order",
  "pending order for",
] as const;

/**
 * Substring fragments RC returns when a transferDomain request is
 * rejected by the registry — bad auth code, transfer-prohibited
 * status, domain inside the post-registration 60-day lock, etc.
 *
 * These are user-actionable (fix the EPP code, contact the losing
 * registrar, wait 60d). Distinguish from hard_failure so the caller
 * can surface a clearer message than "transfer failed".
 */
/**
 * Substring fragments RC uses when a read op (orderid / details lookup)
 * targets a name that doesn't exist on our reseller account. Includes
 * common 404-ish wordings and explicit "no orders" / "no domain"
 * variants.
 */
export const READ_NOT_FOUND_FRAGMENTS = [
  "404",
  "not found",
  "no orders found",
  "no order found",
  "no matching",
  "no entity found",
  "no domain",
  "does not exist",
  "could not find",
] as const;

export const TRANSFER_REJECTED_FRAGMENTS = [
  "auth code",
  "auth-code",
  "authcode",
  "invalid epp",
  "transfer is prohibited",
  "clienttransferprohibited",
  "serverttransferprohibited",
  "60 day",
  "60-day",
  "60days",
  "60 days",
  "not allowed for transfer",
] as const;

export function matchesAny(
  haystack: string | undefined,
  needles: readonly string[]
): boolean {
  if (!haystack) return false;
  const lower = haystack.toLowerCase();
  return needles.some((n) => lower.includes(n));
}

/**
 * Map a raw RC `registerDomain` response onto the typed outcome.
 * Pure — no I/O, no logging. Caller wraps with logging if needed.
 */
export function classifyRegisterDomainResponse(
  res: ResellerClubResponse
): RegisterDomainOutcome {
  if (res.status === "success") {
    const orderId = res.data?.orderid ? String(res.data.orderid) : undefined;
    return orderId
      ? { kind: "registered", orderId }
      : { kind: "registered_no_order_id" };
  }

  if (res.status === "pending") {
    return { kind: "balance_pending" };
  }

  // status === "error" or anything else
  if (matchesAny(res.message, BALANCE_PENDING_FRAGMENTS)) {
    return { kind: "balance_pending" };
  }
  if (matchesAny(res.message, PROCESSING_LOCK_FRAGMENTS)) {
    // Processing-lock acts like balance_pending from the caller's
    // perspective — queue for retry rather than surface a hard error.
    return { kind: "balance_pending" };
  }
  if (matchesAny(res.message, ALREADY_IN_PROGRESS_FRAGMENTS)) {
    return { kind: "already_in_progress" };
  }
  return {
    kind: "hard_failure",
    reason: res.message || `RC returned status=${res.status} with no message`,
  };
}

/**
 * Map a raw RC `renewDomain` response onto the typed outcome. Pure —
 * the orderId / expiry pre-flight failures are folded into the
 * `hard_failure` branch by the wrapper, not classify itself.
 *
 * Reuses BALANCE_PENDING_FRAGMENTS — RC uses identical message
 * vocabulary for renew and register when the reseller account is short.
 */
export function classifyRenewDomainResponse(
  res: ResellerClubResponse
): RenewDomainOutcome {
  if (res.status === "success") {
    const orderId = res.data?.orderid ? String(res.data.orderid) : undefined;
    const priceRaw = res.data?.price;
    const price =
      typeof priceRaw === "number"
        ? priceRaw
        : typeof priceRaw === "string"
        ? Number(priceRaw)
        : undefined;
    return { kind: "renewed", orderId, price: Number.isFinite(price) ? price : undefined };
  }

  if (res.status === "pending") {
    return { kind: "balance_pending" };
  }

  if (
    matchesAny(res.message, BALANCE_PENDING_FRAGMENTS) ||
    matchesAny(res.message, PROCESSING_LOCK_FRAGMENTS)
  ) {
    return { kind: "balance_pending" };
  }
  return {
    kind: "hard_failure",
    reason: res.message || `RC returned status=${res.status} with no message`,
  };
}

/**
 * Map a raw RC `getDomainOrderId` response onto the typed outcome.
 *
 * The inner wrapper in `lib/resellerclub/registration.ts` returns
 * `{status: "success", data: <orderIdString>}` on hit, and a generic
 * `{status: "error", message: "Failed to fetch domain order ID"}` on
 * any throw — that generic message loses the not-found signal. We
 * still match `READ_NOT_FOUND_FRAGMENTS` against the message so the
 * thin layer can disambiguate when RC's wording does leak through.
 */
export function classifyGetDomainOrderIdResponse(
  res: ResellerClubResponse
): GetDomainOrderIdOutcome {
  if (res.status === "success" && res.data) {
    const orderId = String(res.data);
    if (!orderId || orderId === "undefined" || orderId === "null") {
      return {
        kind: "not_found",
        reason: "RC returned success but empty order-id",
      };
    }
    return { kind: "found", orderId };
  }

  if (matchesAny(res.message, READ_NOT_FOUND_FRAGMENTS)) {
    return {
      kind: "not_found",
      reason: res.message || "RC reports no such order",
    };
  }
  return {
    kind: "hard_failure",
    reason: res.message || `RC returned status=${res.status} with no message`,
  };
}

/**
 * Map a raw RC `getDomainDetails` response onto the typed outcome.
 * `data` is RC's raw details object — we cast through the loose
 * `DomainDetailsRecord` interface rather than re-validating field by
 * field (callers parse defensively).
 */
export function classifyGetDomainDetailsResponse(
  res: ResellerClubResponse
): GetDomainDetailsOutcome {
  if (res.status === "success" && res.data) {
    return {
      kind: "found",
      details: res.data as DomainDetailsRecord,
    };
  }

  if (matchesAny(res.message, READ_NOT_FOUND_FRAGMENTS)) {
    return {
      kind: "not_found",
      reason: res.message || "RC reports no such domain",
    };
  }
  return {
    kind: "hard_failure",
    reason: res.message || `RC returned status=${res.status} with no message`,
  };
}

/**
 * Map a raw RC `getDNSRecords` response onto the typed outcome. The
 * inner wrapper already normalises records into `data.records: [...]`
 * (merging RC's per-type fan-out + aliasing recordid/timetolive/host),
 * so the classifier just needs to surface the right `kind` and pull
 * `records` onto the outcome.
 *
 * Empty records is `found` (no records present), not `not_found`
 * (which is reserved for "domain isn't under DNS management here").
 */
export function classifyGetDNSRecordsResponse(
  res: ResellerClubResponse
): GetDNSRecordsOutcome {
  if (res.status === "success" && res.data) {
    const records = Array.isArray((res.data as { records?: unknown }).records)
      ? ((res.data as { records: DnsRecordEntry[] }).records)
      : [];
    return { kind: "found", records };
  }

  if (matchesAny(res.message, READ_NOT_FOUND_FRAGMENTS)) {
    return {
      kind: "not_found",
      reason: res.message || "RC reports no DNS-managed domain",
    };
  }
  return {
    kind: "hard_failure",
    reason: res.message || `RC returned status=${res.status} with no message`,
  };
}

/**
 * Map a raw RC `transferDomain` response onto the typed outcome. Pure.
 * The `entityid` field RC returns is the transfer's tracking id at the
 * registrar — surfaced as `entityId` on the typed outcome.
 *
 * Branches: registry-rejection variants (bad EPP code, transfer-lock)
 * → transfer_rejected; reseller-account-balance → balance_pending;
 * everything else → hard_failure.
 */
export function classifyTransferDomainResponse(
  res: ResellerClubResponse
): TransferDomainOutcome {
  if (res.status === "success") {
    const entityId = res.data?.entityid ? String(res.data.entityid) : undefined;
    return { kind: "transfer_initiated", entityId };
  }

  if (res.status === "pending") {
    return { kind: "balance_pending" };
  }

  if (
    matchesAny(res.message, BALANCE_PENDING_FRAGMENTS) ||
    matchesAny(res.message, PROCESSING_LOCK_FRAGMENTS)
  ) {
    return { kind: "balance_pending" };
  }
  if (matchesAny(res.message, TRANSFER_REJECTED_FRAGMENTS)) {
    return {
      kind: "transfer_rejected",
      reason: res.message || "registry rejected the transfer",
    };
  }
  return {
    kind: "hard_failure",
    reason: res.message || `RC returned status=${res.status} with no message`,
  };
}
