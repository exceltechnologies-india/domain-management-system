import { NextRequest } from "next/server";
import {
  secureJsonResponse,
  secureErrorResponse,
} from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { authorizeCronRequest } from "@/lib/cron-auth";
import {
  listDueServiceHostingCandidates,
  lockHostingForScheduler,
  releaseHostingSchedulerLock,
} from "@/lib/services/hostings";
import Domain from "@/models/Domain";
import { AuthService } from "@/lib/auth";
import { createHttpTask } from "@/lib/cloud-tasks";
import { TimeService } from "@/lib/time-service";
import { ResellerClubAPI } from "@/lib/resellerclub";
import { EmailService } from "@/lib/email";

export const dynamic = "force-dynamic";

/** Maximum services processed per scheduler run (prevents memory pressure) */
const BATCH_SIZE = 500;

/**
 * Check ResellerClub wallet balance and send an alert email if it is below
 * the configured threshold. Swallows all errors so a failure here never
 * blocks or fails the main scheduler run.
 */
async function checkResellerClubBalance(): Promise<
  { checked: false; reason: string } | { checked: true; balance: number; alerted: boolean }
> {
  try {
    const threshold = parseFloat(process.env.RESELLERCLUB_BALANCE_THRESHOLD ?? "1000");
    const adminEmail = process.env.ADMIN_EMAIL ?? "sales@anutech.in";

    const result = await ResellerClubAPI.getResellerDetails();
    if (result.status !== "success" || !result.data) {
      serverLogger.warn("[DailyCron] Balance check skipped — could not fetch RC details");
      return { checked: false, reason: "RC API error" };
    }

    const balance = parseFloat(result.data.availablebalance ?? "0");
    if (isNaN(balance)) {
      serverLogger.warn("[DailyCron] Balance check skipped — unparseable balance value");
      return { checked: false, reason: "unparseable balance" };
    }

    serverLogger.info(`[DailyCron] RC balance: ₹${balance.toFixed(2)} (threshold: ₹${threshold})`);

    if (balance < threshold) {
      await EmailService.sendLowBalanceAlert(adminEmail, {
        availableBalance: balance.toFixed(2),
        threshold,
        resellerName: result.data.name,
        resellerId: result.data.resellerid,
        unutilisedSellingBalance: result.data.unutilisedsellingbalance,
        lockedBalance: result.data.lockedbalance,
      });
      serverLogger.warn(
        `[DailyCron] Low balance alert sent — ₹${balance.toFixed(2)} < ₹${threshold}`
      );
      return { checked: true, balance, alerted: true };
    }

    return { checked: true, balance, alerted: false };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    serverLogger.error(`[DailyCron] Balance check failed: ${message}`);
    return { checked: false, reason: message };
  }
}

/** How long to hold a distributed lock — worker should finish well within this */
const LOCK_DURATION_MS = 10 * 60 * 1000; // 10 minutes

/**
 * GET /api/cron/daily-scheduler
 *
 * Invoked daily by Google Cloud Scheduler.
 * Finds all services where next_action_at is overdue AND not currently locked,
 * atomically acquires a lock on each, then dispatches to the Cloud Tasks queue.
 *
 * Idempotency guarantees:
 * - Only picks up services where processing_until IS NULL or has expired
 * - Atomic findOneAndUpdate ensures only one scheduler/worker picks each service
 * - Uses $lte: now (not "today only") so missed runs catch up automatically
 *
 * Auth: x-cron-secret header OR valid admin session
 */
export async function GET(request: NextRequest) {
  try {
    // ── Auth ──────────────────────────────────────────────────────────────────
    const { searchParams } = new URL(request.url);
    if (!authorizeCronRequest(request)) {
      const isAdmin = await AuthService.isAdmin(request);
      if (!isAdmin) {
        return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
      }
    }

    // Use TimeService to support simulation
    const now = TimeService.now(request);
    const simulatedTime = request.headers.get("x-simulated-time") || searchParams.get("simulatedTime");
    
    const lockExpiry = new Date(now.getTime() + LOCK_DURATION_MS);

    // Eligibility query (`next_action_at <= now` and processing-lock free) is
    // encapsulated by the service helpers below — the hosting variant lives
    // in lib/services/hostings.ts; the Domain side still lives inline.
    const domainEligibilityQuery = {
      next_action_at: { $lte: now },
      $or: [
        { processing_until: null },
        { processing_until: { $exists: false } },
        { processing_until: { $lt: now } },
      ],
      status: { $nin: ["failed", "terminated"] },
    };

    // Fetch candidate IDs only (lean for performance)
    const [candidateHostings, candidateDomains] = await Promise.all([
      listDueServiceHostingCandidates({ now, batchSize: BATCH_SIZE }),
      Domain.find(domainEligibilityQuery).select("_id domainName").limit(BATCH_SIZE),
    ]);

    serverLogger.info(
      `[DailyCron] Candidates: ${candidateHostings.length} hostings, ${candidateDomains.length} domains (at ${now.toISOString()})`
    );

    const queueName = process.env.GCP_QUEUE_NAME || "service-expiry-queue";
    const workerUrl = `${process.env.NEXTAUTH_URL}/api/v1/workers/process-service-expiry`;

    const results = {
      queuedHostings: 0,
      queuedDomains: 0,
      skippedLocked: 0,
      failed: 0,
    };

    // Concurrency cap for lock+enqueue. Each iteration does a Mongo
    // findOneAndUpdate + a Cloud Tasks createHttpTask (~80ms total). Serial
    // 500-row runs took ~80s; chunks of 20 cut that to ~4s without
    // overwhelming the queue.
    const SCHED_CONCURRENCY = 20;

    // ── Process Hostings ──────────────────────────────────────────────────────
    for (let i = 0; i < candidateHostings.length; i += SCHED_CONCURRENCY) {
      const chunk = candidateHostings.slice(i, i + SCHED_CONCURRENCY);
      const outcomes = await Promise.allSettled(
        chunk.map(async (candidate) => {
          // ATOMIC LOCK — only succeeds if the service is still unlocked
          const locked = await lockHostingForScheduler({
            hostingId: candidate._id,
            now,
            lockExpiry,
          });

          if (!locked) return { kind: "skipped" } as const;

          try {
            await createHttpTask(queueName, workerUrl, {
              serviceId: candidate._id.toString(),
              serviceType: "hosting",
              simulatedTime,
            });
            return { kind: "queued" } as const;
          } catch (error: unknown) {
            // Release lock and surface the failure so the caller can count it.
            const message = error instanceof Error ? error.message : String(error);
            serverLogger.error(
              `[DailyCron] Failed to queue hosting ${candidate._id}: ${message}`
            );
            await releaseHostingSchedulerLock({
              hostingId: candidate._id,
              lockExpiry,
            }).catch(() => {});
            return { kind: "failed" } as const;
          }
        })
      );

      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          results.failed++;
          continue;
        }
        if (outcome.value.kind === "skipped") results.skippedLocked++;
        else if (outcome.value.kind === "queued") results.queuedHostings++;
        else results.failed++;
      }
    }

    // ── Process Domains ───────────────────────────────────────────────────────
    for (let i = 0; i < candidateDomains.length; i += SCHED_CONCURRENCY) {
      const chunk = candidateDomains.slice(i, i + SCHED_CONCURRENCY);
      const outcomes = await Promise.allSettled(
        chunk.map(async (candidate) => {
          const locked = await Domain.findOneAndUpdate(
            {
              _id: candidate._id,
              $or: [
                { processing_until: null },
                { processing_until: { $exists: false } },
                { processing_until: { $lt: now } },
              ],
            },
            { $set: { processing_until: lockExpiry } },
            { new: false }
          );

          if (!locked) return { kind: "skipped" } as const;

          try {
            await createHttpTask(queueName, workerUrl, {
              serviceId: candidate._id.toString(),
              serviceType: "domain",
              simulatedTime,
            });
            return { kind: "queued" } as const;
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            serverLogger.error(
              `[DailyCron] Failed to queue domain ${candidate._id}: ${message}`
            );
            await Domain.updateOne(
              { _id: candidate._id, processing_until: lockExpiry },
              { $set: { processing_until: null } }
            ).catch(() => {});
            return { kind: "failed" } as const;
          }
        })
      );

      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          results.failed++;
          continue;
        }
        if (outcome.value.kind === "skipped") results.skippedLocked++;
        else if (outcome.value.kind === "queued") results.queuedDomains++;
        else results.failed++;
      }
    }

    serverLogger.info(
      `[DailyCron] Done — queued ${results.queuedHostings} hostings, ${results.queuedDomains} domains, ` +
      `skipped ${results.skippedLocked} locked, failed ${results.failed}`
    );

    // ── Domain Watch Check ─────────────────────────────────────────────────
    // Fire-and-forget: dispatch to the domain watch worker via a direct fetch.
    // Errors here never block service expiry processing.
    const domainWatchResult = await (async () => {
      try {
        const workerWatchUrl = `${process.env.NEXTAUTH_URL}/api/v1/workers/check-domain-watch`;
        // 60s upper bound — a hung domain-watch worker must not block the
        // cron Cloud Run slot indefinitely.
        const res = await fetch(workerWatchUrl, {
          method: "POST",
          headers: {
            "x-cron-secret": process.env.CRON_SECRET ?? "",
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        serverLogger.error(`[DailyCron] Domain watch check failed: ${message}`);
        return { error: message };
      }
    })();

    // ── ResellerClub Balance Alert ─────────────────────────────────────────
    // Runs after service processing so a balance failure never blocks the main job.
    const balanceResult = await checkResellerClubBalance();

    return secureJsonResponse({ success: true, data: { ...results, domainWatch: domainWatchResult, balanceAlert: balanceResult } });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    serverLogger.error("[DailyCron] Critical Error:", message);
    return secureErrorResponse(
      "Internal Server Error during daily scheduler",
      500,
      "CRON_SCHEDULER_FAILED"
    );
  }
}
