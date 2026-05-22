/**
 * Pure response-classification for `registerDomain`. Extracted from
 * `register-domain.ts` so it can be unit-tested in isolation — the
 * registerDomain wrapper itself imports the heavy ResellerClubWrapper
 * module, which throws at module load when its env vars are missing
 * (test envs don't set them).
 */
import type { ResellerClubResponse } from "@/lib/types";
import type { RegisterDomainOutcome, RenewDomainOutcome } from "./types";

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
