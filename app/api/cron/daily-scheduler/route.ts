import { NextRequest } from "next/server";
import {
  secureJsonResponse,
  secureErrorResponse,
} from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import connectDB from "@/lib/mongodb";
import crypto from "crypto";
import Hosting from "@/models/Hosting";
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
  } catch (err: any) {
    serverLogger.error(`[DailyCron] Balance check failed: ${err.message}`);
    return { checked: false, reason: err.message };
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
    const cronSecret = process.env.CRON_SECRET;
    const providedSecret = request.headers.get("x-cron-secret") ?? "";
    const isCron =
      cronSecret !== undefined &&
      cronSecret.length > 0 &&
      providedSecret.length === cronSecret.length &&
      crypto.timingSafeEqual(Buffer.from(providedSecret), Buffer.from(cronSecret));

    if (!isCron) {
      const isAdmin = await AuthService.isAdmin(request);
      if (!isAdmin) {
        return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
      }
    }

    await connectDB();

    // Use TimeService to support simulation
    const now = TimeService.now(request);
    const simulatedTime = request.headers.get("x-simulated-time") || searchParams.get("simulatedTime");
    
    const lockExpiry = new Date(now.getTime() + LOCK_DURATION_MS);

    /**
     * Query: services that are due for action AND not currently locked.
     * - next_action_at <= now — catches up on any missed runs automatically
     * - processing_until IS NULL OR processing_until < now — only unlocked services
     * - status NOT IN terminal states — don't re-process terminated/failed services
     */
    const eligibilityQuery = {
      next_action_at: { $lte: now },
      $or: [
        { processing_until: null },
        { processing_until: { $exists: false } },
        { processing_until: { $lt: now } }, // Expired locks are also eligible
      ],
      status: { $nin: ["failed", "terminated"] },
    };

    // Fetch candidate IDs only (lean for performance)
    const [candidateHostings, candidateDomains] = await Promise.all([
      Hosting.find(eligibilityQuery).select("_id domainName").limit(BATCH_SIZE),
      Domain.find(eligibilityQuery).select("_id domainName").limit(BATCH_SIZE),
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

    // ── Process Hostings ──────────────────────────────────────────────────────
    for (const candidate of candidateHostings) {
      try {
        // ATOMIC LOCK — only succeeds if the service is still unlocked
        const locked = await Hosting.findOneAndUpdate(
          {
            _id: candidate._id,
            $or: [
              { processing_until: null },
              { processing_until: { $exists: false } },
              { processing_until: { $lt: now } },
            ],
          },
          { $set: { processing_until: lockExpiry } },
          { new: false } // Return the old doc (we just need to know if it matched)
        );

        if (!locked) {
          // Another scheduler/worker already locked this service
          results.skippedLocked++;
          continue;
        }

        // Push to Cloud Tasks
        await createHttpTask(queueName, workerUrl, {
          serviceId: candidate._id.toString(),
          serviceType: "hosting",
          simulatedTime, // Pass simulated time to worker
        });

        results.queuedHostings++;
      } catch (error: any) {
        serverLogger.error(
          `[DailyCron] Failed to lock/queue hosting ${candidate._id}: ${error.message}`
        );
        results.failed++;

        // Release the lock if we acquired it but failed to queue
        await Hosting.updateOne(
          { _id: candidate._id, processing_until: lockExpiry },
          { $set: { processing_until: null } }
        ).catch(() => {});
      }
    }

    // ── Process Domains ───────────────────────────────────────────────────────
    for (const candidate of candidateDomains) {
      try {
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

        if (!locked) {
          results.skippedLocked++;
          continue;
        }

        await createHttpTask(queueName, workerUrl, {
          serviceId: candidate._id.toString(),
          serviceType: "domain",
          simulatedTime, // Pass simulated time to worker
        });

        results.queuedDomains++;
      } catch (error: any) {
        serverLogger.error(
          `[DailyCron] Failed to lock/queue domain ${candidate._id}: ${error.message}`
        );
        results.failed++;

        // Release lock on queue failure
        await Domain.updateOne(
          { _id: candidate._id, processing_until: lockExpiry },
          { $set: { processing_until: null } }
        ).catch(() => {});
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
        const res = await fetch(workerWatchUrl, {
          method: "POST",
          headers: {
            "x-cron-secret": process.env.CRON_SECRET ?? "",
            "Content-Type": "application/json",
          },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (err: any) {
        serverLogger.error(`[DailyCron] Domain watch check failed: ${err.message}`);
        return { error: err.message };
      }
    })();

    // ── ResellerClub Balance Alert ─────────────────────────────────────────
    // Runs after service processing so a balance failure never blocks the main job.
    const balanceResult = await checkResellerClubBalance();

    return secureJsonResponse({ success: true, data: { ...results, domainWatch: domainWatchResult, balanceAlert: balanceResult } });
  } catch (error: any) {
    serverLogger.error("[DailyCron] Critical Error:", error.message);
    return secureErrorResponse(
      "Internal Server Error during daily scheduler",
      500,
      "CRON_SCHEDULER_FAILED"
    );
  }
}
