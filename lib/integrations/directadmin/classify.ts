/**
 * Pure classification helpers for DirectAdmin error responses.
 * Extracted from `create-user.ts` so they can be unit-tested without
 * the DA module's env-checked module load.
 */

/**
 * DA error message fragments that mean "the username we tried already
 * exists on the server" — caller should retry with a different
 * candidate. Lowercased substring match.
 */
export const USERNAME_COLLISION_FRAGMENTS = [
  "already exists",
] as const;

/**
 * DA error message fragments returned when the username we're operating
 * on isn't on the server (deleted out-of-band, or never created).
 * Caller should treat as terminal — retries can't fix it.
 *
 * Conservative list; expand as new variants are seen in prod logs.
 */
export const USER_NOT_FOUND_FRAGMENTS = [
  "unable to find user",
  "no such user",
  "user does not exist",
  "user not found",
  "unknown user",
  "cannot find user",
] as const;

export function matchesAny(haystack: string | undefined, needles: readonly string[]): boolean {
  if (!haystack) return false;
  const lower = haystack.toLowerCase();
  return needles.some((n) => lower.includes(n));
}

/**
 * Discriminate the three failure modes a single DA createUser call can
 * land in: username collision (retryable with a new candidate), DA
 * unreachable (queue for later retry by the cron), or hard failure.
 *
 * `daStatus` is the HTTP-like status carried on `DirectAdminError`
 * (typically 503 when DA's nginx is up but the backend is down, or 200
 * when DA returned its in-band `error=1` form). Pass undefined for
 * generic Errors.
 */
export type SingleCreateUserAttempt =
  | { kind: "collision" }
  | { kind: "unreachable"; reason: string }
  | { kind: "hard"; reason: string };

export function classifyCreateUserError(
  errorMessage: string | undefined,
  daStatus: number | undefined
): SingleCreateUserAttempt {
  if (matchesAny(errorMessage, USERNAME_COLLISION_FRAGMENTS)) {
    return { kind: "collision" };
  }
  if (daStatus === 503) {
    return { kind: "unreachable", reason: errorMessage || "DA returned 503" };
  }
  return { kind: "hard", reason: errorMessage || "DA createUser failed" };
}

/**
 * Discriminate the failure modes of a DA suspendUser call. Symmetric
 * with classifyCreateUserError but with a different vocabulary —
 * suspendUser doesn't have collisions but does have a meaningful
 * user_not_found signal.
 */
export type SingleSuspendUserAttempt =
  | { kind: "user_not_found"; reason: string }
  | { kind: "unreachable"; reason: string }
  | { kind: "hard"; reason: string };

export function classifySuspendUserError(
  errorMessage: string | undefined,
  daStatus: number | undefined
): SingleSuspendUserAttempt {
  if (matchesAny(errorMessage, USER_NOT_FOUND_FRAGMENTS)) {
    return {
      kind: "user_not_found",
      reason: errorMessage || "DA reported user not found",
    };
  }
  if (daStatus === 503) {
    return { kind: "unreachable", reason: errorMessage || "DA returned 503" };
  }
  return { kind: "hard", reason: errorMessage || "DA suspendUser failed" };
}
