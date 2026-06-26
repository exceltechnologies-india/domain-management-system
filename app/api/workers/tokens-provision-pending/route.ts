/**
 * Tokens-flow DA-provisioning worker (Phase 2H).
 *
 * HTTP-invocable counterpart to `scripts/provision-pending-tokens-hostings.js`
 * (the Node CLI from Phase 2E). Cloud Scheduler can only call HTTP endpoints,
 * not run Node directly — so this worker is the production cron target.
 *
 * Behavior is identical to the CLI: query Hostings with status='pending' +
 * razorpayTokenId set + directAdminUsername empty, call
 * provisionTokensFlowHosting per row, return a summary.
 *
 * Cloud Scheduler setup (operator action; not yet wired):
 *   gcloud scheduler jobs create http tokens-provision-pending \
 *     --schedule="*\/10 * * * *" \
 *     --uri="https://app.anutech.in/api/workers/tokens-provision-pending" \
 *     --http-method=POST \
 *     --headers="x-cron-secret=$CRON_SECRET" \
 *     --location=asia-south1
 *
 * Safety:
 *   - CRON_SECRET auth via authorizeCronRequest (same pattern as other workers).
 *   - Refuses to do work unless HOSTING_MANDATE_FLOW=tokens — defensive guard
 *     so flipping the flag is the single source of truth for "Tokens flow is live".
 *   - Per-Hosting errors don't block the batch (the underlying service module
 *     already handles its own retries via leaving status='pending').
 */
import { NextRequest } from "next/server";
import { authorizeCronRequest } from "@/lib/cron-auth";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import {
  findPendingTokensFlowHostings,
  provisionTokensFlowHosting,
} from "@/lib/services/payment/tokens-da-provisioner";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!authorizeCronRequest(request)) {
    return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
  }

  if (process.env.HOSTING_MANDATE_FLOW !== "tokens") {
    serverLogger.info(
      "[Worker:tokens-provision-pending] HOSTING_MANDATE_FLOW not 'tokens' — no-op"
    );
    return secureJsonResponse({
      success: true,
      message: "Skipped (HOSTING_MANDATE_FLOW != tokens)",
      counts: { activated: 0, skipped: 0, da_unreachable: 0, collision_exhausted: 0, hard_failure: 0 },
    });
  }

  const pending = await findPendingTokensFlowHostings({ limit: 100 });
  serverLogger.info(
    `[Worker:tokens-provision-pending] Found ${pending.length} Hostings pending DA provisioning`
  );

  const counts = {
    activated: 0,
    skipped: 0,
    da_unreachable: 0,
    collision_exhausted: 0,
    hard_failure: 0,
  };
  const errors: string[] = [];

  for (const hosting of pending) {
    try {
      const result = await provisionTokensFlowHosting(hosting);
      switch (result.outcome) {
        case "activated":
          counts.activated += 1;
          break;
        case "skipped":
          counts.skipped += 1;
          break;
        case "da_unreachable":
          counts.da_unreachable += 1;
          break;
        case "collision_exhausted":
          counts.collision_exhausted += 1;
          break;
        case "hard_failure":
          counts.hard_failure += 1;
          break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${hosting.domainName}: ${msg}`);
      serverLogger.error(
        `[Worker:tokens-provision-pending] Unexpected error on ${hosting.domainName}: ${msg}`
      );
    }
  }

  serverLogger.info(
    `[Worker:tokens-provision-pending] Batch complete — ${JSON.stringify(counts)}${errors.length ? ` (${errors.length} unexpected errors)` : ""}`
  );

  return secureJsonResponse({
    success: true,
    counts,
    errors: errors.length ? errors : undefined,
  });
}
