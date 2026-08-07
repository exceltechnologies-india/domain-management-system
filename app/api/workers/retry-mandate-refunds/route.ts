/**
 * Retry-failed-mandate-refunds worker.
 *
 * HTTP-invocable sweep that re-attempts the ₹2 trial mandate-validation refunds
 * that failed inline in the webhook (Order.mandateRefundStatus='failed'). The
 * inline refund fires once, immediately after capture, and a just-captured
 * recurring-auth payment can transiently reject it — leaving the ₹2 un-refunded
 * with no retry. This closes that money-loss gap: since the payment stays
 * refundable, a retry minutes later succeeds. Idempotent (reconciles orders
 * Razorpay already refunded instead of double-refunding).
 *
 * Cloud Scheduler setup (run once, operator-side):
 *   gcloud scheduler jobs create http retry-mandate-refunds \
 *     --location=asia-south1 --schedule="7,37 * * * *" \
 *     --uri="https://app.anutech.in/api/workers/retry-mandate-refunds" \
 *     --http-method=POST --headers="x-cron-secret=$CRON_SECRET" \
 *     --message-body='{}'
 *   (every 30 min, offset from the other crons; a dropped run just retries next.)
 *
 * Safety: CRON_SECRET auth via authorizeCronRequest (same as other workers).
 * serverLogger is silenced in prod, so the HTTP response is the channel that
 * surfaces the per-run counts.
 */
import { NextRequest } from "next/server";
import { authorizeCronRequest } from "@/lib/cron-auth";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { retryFailedMandateRefunds } from "@/lib/services/payment/mandate-refund-retry";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!authorizeCronRequest(request)) {
    return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
  }

  const result = await retryFailedMandateRefunds({ limit: 50 });
  serverLogger.info(`[Worker:retry-mandate-refunds] ${JSON.stringify(result)}`);
  return secureJsonResponse({ success: true, ...result });
}
