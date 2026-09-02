import { NextRequest } from "next/server";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { EmailService } from "@/lib/email";
import { AuthService } from "@/lib/auth";
import { authorizeCronRequest } from "@/lib/cron-auth";
import connectDB from "@/lib/mongodb";
import Order from "@/models/Order";
import { AUTOMATION_CONFIG } from "@/config/automation";

export const dynamic = "force-dynamic";

/**
 * Primary Billing Integration Phase 2 — renewal-payment dunning.
 *
 * Chases renewal Orders (orderType='renewal', created at
 * /api/user/hosting/renew) stuck in status='pending' because the customer
 * opened the Razorpay checkout but never completed payment. Every such
 * call mints a brand-new pending Order (see renew/route.ts) with no
 * dedup/expiry — without this cron, an abandoned checkout is never
 * followed up.
 *
 * Escalation: AUTOMATION_CONFIG.RENEWAL_DUNNING_HOURS (default
 * [24, 72, 168] = 1 day, 3 days, 7 days after order creation). After the
 * LAST stage is sent, `dunningAbandonedAt` is set and no further reminders
 * go out — the order's `status` is intentionally left as-is ('pending');
 * this cron only sends reminders, it doesn't decide whether to void
 * long-abandoned orders.
 *
 * Modeled on the simpler single-route shape of
 * app/api/cron/pending-sweeper/route.ts (find + notify inline) rather than
 * the cron+Cloud-Tasks-worker split used for high-volume crons — abandoned
 * renewal checkouts are expected to be a low-volume population.
 *
 * Auth: x-cron-secret header (timing-safe) OR admin session.
 * Recommended schedule: a few times a day (reminders are hour-granularity).
 *
 * Cloud Scheduler example (every 6 hours):
 *   gcloud scheduler jobs create http renewal-payment-dunning \
 *     --schedule="0 0,6,12,18 * * *" --time-zone="Asia/Kolkata" \
 *     --uri="https://app.anutech.in/api/cron/renewal-payment-dunning" \
 *     --http-method=GET \
 *     --headers="x-cron-secret=$CRON_SECRET"
 */

const HOURS_MS = 60 * 60 * 1000;

interface DunningCandidate {
  _id: unknown;
  orderId: string;
  userId: unknown;
  userEmail?: string;
  userName?: string;
  amount: number;
  currency: string;
  createdAt: Date;
  dunningLastStageHours?: number;
  domains: Array<{
    domainName: string;
    hostingPlan?: { name?: string };
  }>;
}

export async function GET(request: NextRequest) {
  try {
    if (!authorizeCronRequest(request)) {
      const isAdmin = await AuthService.isAdmin(request);
      if (!isAdmin) {
        return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
      }
    }

    await connectDB();

    const stages: number[] = [...AUTOMATION_CONFIG.RENEWAL_DUNNING_HOURS].sort(
      (a, b) => a - b
    );
    const finalStage = stages[stages.length - 1];
    const now = Date.now();
    const earliestCutoff = new Date(now - stages[0] * HOURS_MS);

    const candidates = (await Order.find({
      status: "pending",
      orderType: "renewal",
      dunningAbandonedAt: { $exists: false },
      createdAt: { $lt: earliestCutoff },
    })
      .select(
        "orderId userId userEmail userName amount currency createdAt dunningLastStageHours domains"
      )
      .lean()) as unknown as DunningCandidate[];

    let sent = 0;
    let abandoned = 0;
    let skipped = 0;

    for (const order of candidates) {
      const ageHours = (now - new Date(order.createdAt).getTime()) / HOURS_MS;

      // Walk stages descending — find the highest stage this order has
      // reached that hasn't been sent yet.
      let targetStage: number | null = null;
      for (let i = stages.length - 1; i >= 0; i--) {
        if (ageHours >= stages[i] && (order.dunningLastStageHours ?? 0) < stages[i]) {
          targetStage = stages[i];
          break;
        }
      }

      if (targetStage === null) {
        skipped++;
        continue;
      }

      if (!order.userEmail) {
        serverLogger.warn(
          `[RenewalDunning] Order ${order.orderId} has no userEmail on file — skipping reminder, not the counter`
        );
        skipped++;
        continue;
      }

      const domain = order.domains?.[0];
      const isFinalStage = targetStage === finalStage;

      try {
        await EmailService.sendRenewalPaymentPendingEmail(
          order.userEmail,
          order.userName || "Customer",
          {
            domainName: domain?.domainName || "your hosting",
            planName: domain?.hostingPlan?.name || "Hosting Plan",
            amount: order.amount,
            currency: order.currency,
            stageHours: targetStage,
            isFinalStage,
          }
        );
        sent++;

        const update: Record<string, unknown> = { dunningLastStageHours: targetStage };
        if (isFinalStage) {
          update.dunningAbandonedAt = new Date();
          abandoned++;
        }
        await Order.updateOne({ _id: order._id }, { $set: update });

        serverLogger.info(
          `[RenewalDunning] Sent stage=${targetStage}h reminder for order ${order.orderId}` +
            (isFinalStage ? " (final — no further reminders)" : "")
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        serverLogger.error(
          `[RenewalDunning] Failed to send reminder for order ${order.orderId}: ${message}`
        );
      }
    }

    serverLogger.info(
      `[RenewalDunning] Checked ${candidates.length} candidate(s): sent=${sent} abandoned=${abandoned} skipped=${skipped}`
    );

    return secureJsonResponse({
      checked: candidates.length,
      sent,
      abandoned,
      skipped,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    serverLogger.error("[RenewalDunning] Error:", message);
    return secureErrorResponse("Internal error", 500, "INTERNAL_ERROR");
  }
}
