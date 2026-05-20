/**
 * Cron / worker route authorisation.
 *
 * Two failure modes we explicitly fence:
 *
 *   1. Non-timing-safe string compare. Before this helper landed, four worker
 *      routes used `authHeader !== process.env.CRON_SECRET` directly. That
 *      compare leaks one character of timing per request — attackers can
 *      iterate to recover the secret over many probes. `crypto.timingSafeEqual`
 *      compares in constant time.
 *   2. Length mismatch passed straight into `timingSafeEqual` (which throws on
 *      buffers of different lengths). We guard the length check first so a
 *      missing or malformed header returns a clean "unauthorized" instead of
 *      bubbling up as a 500.
 *
 * Routes use this two ways:
 *   - Cloud Scheduler hits the route with `x-cron-secret: $CRON_SECRET`.
 *   - Admins can replay the same route from the dashboard — those requests
 *     fail this check, then routes fall through to `AuthService.isAdmin`.
 *
 * Routes call:
 *   const isCron = await authorizeCronRequest(request);
 *   if (!isCron) {
 *     const isAdmin = await AuthService.isAdmin(request);
 *     if (!isAdmin) return secureErrorResponse("Unauthorized", 401, "...");
 *   }
 */
import crypto from "crypto";
import type { NextRequest } from "next/server";

/**
 * Returns true when the request carries a valid `x-cron-secret` header
 * matching `process.env.CRON_SECRET`. Returns false in every other case
 * (missing env, missing header, length mismatch, value mismatch). Never
 * throws — callers can fall through to a session-based admin check.
 */
export function authorizeCronRequest(request: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || cronSecret.length === 0) return false;

  const providedSecret = request.headers.get("x-cron-secret") ?? "";
  if (providedSecret.length !== cronSecret.length) return false;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(providedSecret),
      Buffer.from(cronSecret)
    );
  } catch {
    // timingSafeEqual throws on weird inputs (eg non-UTF8 bytes) — treat as
    // a failed compare rather than a 500.
    return false;
  }
}
