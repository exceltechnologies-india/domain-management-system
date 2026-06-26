/**
 * Tokens-flow MIT recurring-charge worker (Phase 2H).
 *
 * HTTP-invocable counterpart to `scripts/charge-recurring-hostings.js`
 * (the Node CLI from Phase 2D). Cloud Scheduler can only call HTTP endpoints,
 * not run Node directly — so this worker is the production cron target.
 *
 * Behavior is identical to the CLI in --apply mode: find Hostings with
 * expiryDate <= today+1d AND razorpayTokenId set, call chargeRecurringHosting
 * per row, return a summary. On Phase 2F's 'abandoned' outcome, the service
 * module ALSO suspends DA + flips Hosting.status='expired' + sends suspension
 * email (those are inside chargeRecurringHosting, not here).
 *
 * Cloud Scheduler setup (operator action; not yet wired):
 *   gcloud scheduler jobs create http tokens-charge-recurring \
 *     --schedule="0 22 * * *" \
 *     --time-zone="Asia/Kolkata" \
 *     --uri="https://app.anutech.in/api/workers/tokens-charge-recurring" \
 *     --http-method=POST \
 *     --headers="x-cron-secret=$CRON_SECRET" \
 *     --location=asia-south1
 *   (22:00 UTC = 03:30 IST next day; adjust as needed)
 *
 * Safety:
 *   - CRON_SECRET auth via authorizeCronRequest.
 *   - Refuses to do work unless HOSTING_MANDATE_FLOW=tokens — defensive guard.
 *   - Refuses unless RAZORPAY_KEY_ID starts with 'rzp_live_' (this is a
 *     real-money endpoint; a misconfigured test-mode call would still charge
 *     customers IF rzp_test_ keys happen to overlap; belt + suspenders).
 *   - Per-Hosting errors don't block the batch (the underlying state machine
 *     already handles retries via RecurringChargeAttempt.nextAttemptAt).
 */
import { NextRequest } from "next/server";
import { authorizeCronRequest } from "@/lib/cron-auth";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import {
  findHostingsDueForCharge,
  chargeRecurringHosting,
} from "@/lib/services/payment/recurring-charge-service";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!authorizeCronRequest(request)) {
    return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
  }

  if (process.env.HOSTING_MANDATE_FLOW !== "tokens") {
    serverLogger.info(
      "[Worker:tokens-charge-recurring] HOSTING_MANDATE_FLOW not 'tokens' — no-op"
    );
    return secureJsonResponse({
      success: true,
      message: "Skipped (HOSTING_MANDATE_FLOW != tokens)",
      counts: { succeeded: 0, retry_scheduled: 0, abandoned: 0, skipped: 0 },
    });
  }

  const keyId = process.env.RAZORPAY_KEY_ID || "";
  if (!keyId.startsWith("rzp_live_")) {
    serverLogger.error(
      `[Worker:tokens-charge-recurring] REFUSING: RAZORPAY_KEY_ID is '${keyId.substring(0, 12)}…', not 'rzp_live_*' — this is a real-money endpoint`
    );
    return secureErrorResponse(
      "Refusing to run against non-live Razorpay key",
      400,
      "NON_LIVE_KEY"
    );
  }

  const due = await findHostingsDueForCharge({ limit: 100 });
  serverLogger.info(
    `[Worker:tokens-charge-recurring] Found ${due.length} Hostings due for recurring charge`
  );

  const counts = {
    succeeded: 0,
    retry_scheduled: 0,
    abandoned: 0,
    skipped: 0,
  };
  const errors: string[] = [];

  for (const hosting of due) {
    try {
      const result = await chargeRecurringHosting(hosting);
      switch (result.outcome) {
        case "succeeded":
          counts.succeeded += 1;
          break;
        case "retry_scheduled":
          counts.retry_scheduled += 1;
          break;
        case "abandoned":
          counts.abandoned += 1;
          break;
        case "skipped":
          counts.skipped += 1;
          break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${hosting.domainName}: ${msg}`);
      serverLogger.error(
        `[Worker:tokens-charge-recurring] Unexpected error on ${hosting.domainName}: ${msg}`
      );
    }
  }

  serverLogger.info(
    `[Worker:tokens-charge-recurring] Batch complete — ${JSON.stringify(counts)}${errors.length ? ` (${errors.length} unexpected errors)` : ""}`
  );

  return secureJsonResponse({
    success: true,
    counts,
    errors: errors.length ? errors : undefined,
  });
}
