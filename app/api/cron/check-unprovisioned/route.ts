import { NextRequest } from "next/server";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { EmailService } from "@/lib/email";
import { AuthService } from "@/lib/auth";
import { authorizeCronRequest } from "@/lib/cron-auth";
import type { IOrder } from "@/models/Order";
import { listStuckCompletedOrders } from "@/lib/services/orders";
import {
  listDeferredPendingHostings,
  provisionPendingHosting,
} from "@/lib/services/pending-hostings";

export const dynamic = "force-dynamic";

/**
 * Two-part cron:
 *
 * 1. **Auto-retry deferred hostings.** Drains `PendingHosting` rows with
 *    `status: "pending"` (the soft-fail rows the provisioner writes when DA
 *    is unreachable at checkout-time, added 2026-05-19). Each row is retried
 *    via {@link provisionPendingHosting} — the same code path the admin
 *    "Retry" button uses, so manual + auto retries stay in sync. DA is
 *    cheap once reachable; DA-still-unreachable retries fail-fast at the
 *    same code path that wrote the row in the first place.
 *
 * 2. **Alert on stuck orders.** Scans for completed orders > 30 min old
 *    whose domain-side hasn't reached "registered". Emails admin with the
 *    list (the auto-retry above handles the hosting side; this catches the
 *    domain side, ResellerClub stalls, and any genuinely-failed hostings).
 *
 * Auth: x-cron-secret header (timing-safe comparison) OR admin session.
 * Recommended schedule: every 30 minutes via external cron trigger.
 */
export async function GET(request: NextRequest) {
  try {
    if (!authorizeCronRequest(request)) {
      const isAdmin = await AuthService.isAdmin(request);
      if (!isAdmin) {
        return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
      }
    }

    // ── Part 1: drain deferred PendingHosting rows ──────────────────────────
    // Concurrency-capped fan-out: DA `createUser` is the bottleneck (~2s
    // cold). Running 50 serially blows the Cloud Tasks visibility timeout.
    // Cap at 5 to stay friendly to DA without throttling ourselves.
    const deferred = await listDeferredPendingHostings();
    const retryResults = { attempted: deferred.length, succeeded: 0, dropped: 0, failed: 0 };
    const CONCURRENCY = 5;
    for (let i = 0; i < deferred.length; i += CONCURRENCY) {
      const chunk = deferred.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        chunk.map((pending) => provisionPendingHosting(pending))
      );
      for (const r of results) {
        if (r.status === "fulfilled" && r.value.ok) {
          if (r.value.dropped) retryResults.dropped += 1;
          else retryResults.succeeded += 1;
        } else {
          retryResults.failed += 1;
        }
      }
    }
    if (deferred.length > 0) {
      serverLogger.info(
        `[CheckUnprovisioned] Auto-retry drained ${deferred.length} deferred hosting(s): ` +
        `${retryResults.succeeded} provisioned, ${retryResults.dropped} dropped, ${retryResults.failed} still failing`
      );
    }

    // ── Part 2: alert on stuck orders ───────────────────────────────────────
    const stuckOrders = await listStuckCompletedOrders({
      staleAfterMs: 30 * 60 * 1000,
      select: "orderId userEmail userName createdAt domains",
    });

    serverLogger.info(`[CheckUnprovisioned] Found ${stuckOrders.length} stuck orders`);

    if (stuckOrders.length > 0) {
      const adminEmail = process.env.ADMIN_EMAIL ?? "sales@anutech.in";

      type StuckOrder = Pick<IOrder, "orderId" | "userEmail" | "userName" | "createdAt" | "domains">;
      const orders = stuckOrders as unknown as StuckOrder[];
      const orderList = orders
        .map((o) => {
          const pendingDomains = (o.domains || [])
            .filter((d) => d.status === "pending")
            .map((d) => d.domainName)
            .join(", ");
          const age = Math.round((Date.now() - new Date(o.createdAt).getTime()) / 60000);
          return `• ${o.orderId} — ${o.userEmail || o.userName} — ${pendingDomains} (${age} min ago)`;
        })
        .join("\n");

      await EmailService.sendAdminNotification(
        adminEmail,
        `${stuckOrders.length} paid order(s) have unprovisioned services`,
        `The following completed orders have domains still in <strong>pending</strong> status after 30+ minutes. Manual retry may be required via the admin panel.`,
        { stuckOrders: orders.map((o) => ({ orderId: o.orderId, userEmail: o.userEmail, createdAt: o.createdAt })) }
      ).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        serverLogger.error(`[CheckUnprovisioned] Failed to send admin alert: ${message}`);
      });

      serverLogger.warn(`[CheckUnprovisioned] Admin alerted for ${stuckOrders.length} stuck orders:\n${orderList}`);
    }

    return secureJsonResponse({
      checked: stuckOrders.length,
      retry: retryResults,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    serverLogger.error("[CheckUnprovisioned] Error:", message);
    return secureErrorResponse("Internal error", 500, "INTERNAL_ERROR");
  }
}
