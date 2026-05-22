/**
 * Pure response-classification for `registerDomain`. Extracted from
 * `register-domain.ts` so it can be unit-tested in isolation — the
 * registerDomain wrapper itself imports the heavy ResellerClubWrapper
 * module, which throws at module load when its env vars are missing
 * (test envs don't set them).
 */
import type { ResellerClubResponse } from "@/lib/types";
import type { RegisterDomainOutcome } from "./types";

/**
 * Substring fragments RC's error messages use when registration is
 * deferred for balance / credit reasons. Kept here as a private constant
 * so any RC wording drift is fixed in one place.
 */
export const BALANCE_PENDING_FRAGMENTS = [
  "insufficient balance",
  "low funds",
  "insufficient funds",
  "account balance",
  "credit limit",
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
  if (matchesAny(res.message, ALREADY_IN_PROGRESS_FRAGMENTS)) {
    return { kind: "already_in_progress" };
  }
  return {
    kind: "hard_failure",
    reason: res.message || `RC returned status=${res.status} with no message`,
  };
}
