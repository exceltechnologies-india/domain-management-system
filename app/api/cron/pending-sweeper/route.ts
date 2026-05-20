import { NextRequest } from "next/server";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { EmailService } from "@/lib/email";
import { AuthService } from "@/lib/auth";
import { authorizeCronRequest } from "@/lib/cron-auth";
import connectDB from "@/lib/mongodb";
import PendingDomain from "@/models/PendingDomain";
import { listStuckPendingHostings } from "@/lib/services/pending-hostings";

export const dynamic = "force-dynamic";

/**
 * Scans PendingDomain and PendingHosting for records stuck >24h in non-terminal
 * statuses (pending / processing / failed). Sends a single digest email to ADMIN_EMAIL
 * listing each stuck record with severity (WARN for 24h-7d, CRITICAL for >7d or
 * verificationAttempts > 5). Does not auto-archive or delete — admin acts manually
 * to avoid silently hiding provisioning failures.
 *
 * Auth: x-cron-secret header (timing-safe) OR admin session.
 * Recommended schedule: daily, once. Daily cadence is the dedupe strategy —
 * admin gets at most one digest per day until the records are resolved.
 *
 * Cloud Scheduler example:
 *   gcloud scheduler jobs create http pending-sweeper \
 *     --schedule="0 9 * * *" --time-zone="Asia/Kolkata" \
 *     --uri="https://app.anutech.in/api/cron/pending-sweeper" \
 *     --http-method=GET \
 *     --headers="x-cron-secret=$CRON_SECRET"
 */

const WARN_AGE_MS = 24 * 60 * 60 * 1000;
const CRITICAL_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CRITICAL_ATTEMPT_THRESHOLD = 5;

type Severity = "WARN" | "CRITICAL";

interface StuckSummary {
  collection: "PendingDomain" | "PendingHosting";
  id: string;
  identifier: string;
  status: string;
  ageHours: number;
  severity: Severity;
  reason: string;
  attempts?: number;
}

function ageHours(createdAt: Date | string, now: number): number {
  return Math.round((now - new Date(createdAt).getTime()) / (60 * 60 * 1000));
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

    const now = Date.now();
    const warnCutoff = new Date(now - WARN_AGE_MS);
    const criticalCutoff = new Date(now - CRITICAL_AGE_MS);

    // PendingDomain: skip archived records, look at non-terminal statuses only.
    const stuckPendingDomains = await PendingDomain.find({
      isArchived: { $ne: true },
      status: { $in: ["pending", "processing", "failed"] },
      createdAt: { $lt: warnCutoff },
    })
      .select("domainName status createdAt verificationAttempts reason orderId userId")
      .lean();

    // PendingHosting: no isArchived flag. Status field is "pending" or "failed".
    const stuckPendingHostings = await listStuckPendingHostings(warnCutoff);

    const summaries: StuckSummary[] = [];

    interface StuckPendingDomainRow {
      _id: unknown;
      domainName: string;
      status: string;
      createdAt: Date;
      verificationAttempts?: number;
      reason?: string;
    }
    for (const d of stuckPendingDomains as unknown as StuckPendingDomainRow[]) {
      const attempts = d.verificationAttempts ?? 0;
      const tooOld = new Date(d.createdAt).getTime() < criticalCutoff.getTime();
      const tooManyAttempts = attempts > CRITICAL_ATTEMPT_THRESHOLD;
      const severity: Severity = tooOld || tooManyAttempts ? "CRITICAL" : "WARN";
      const reasonParts: string[] = [];
      if (tooOld) reasonParts.push(`>${CRITICAL_AGE_MS / 86400000}d old`);
      if (tooManyAttempts) reasonParts.push(`${attempts} verification attempts`);
      if (!reasonParts.length) reasonParts.push("stuck >24h");

      summaries.push({
        collection: "PendingDomain",
        id: String(d._id),
        identifier: d.domainName,
        status: d.status,
        ageHours: ageHours(d.createdAt, now),
        severity,
        reason: `${d.reason || "no reason recorded"} — ${reasonParts.join(", ")}`,
        attempts,
      });
    }

    for (const h of stuckPendingHostings) {
      const tooOld = new Date(h.createdAt).getTime() < criticalCutoff.getTime();
      const severity: Severity = tooOld ? "CRITICAL" : "WARN";
      summaries.push({
        collection: "PendingHosting",
        id: String(h._id),
        identifier: h.domain,
        status: h.status,
        ageHours: ageHours(h.createdAt, now),
        severity,
        reason: `${h.error || "no error recorded"}${tooOld ? ` — >${CRITICAL_AGE_MS / 86400000}d old` : ""}`,
      });
    }

    const criticalCount = summaries.filter((s) => s.severity === "CRITICAL").length;
    const warnCount = summaries.length - criticalCount;

    serverLogger.info(
      `[PendingSweeper] Stuck records: ${summaries.length} total (CRITICAL=${criticalCount}, WARN=${warnCount})`
    );

    if (summaries.length > 0) {
      const adminEmail = process.env.ADMIN_EMAIL ?? "sales@anutech.in";

      const sortedSummaries = [...summaries].sort((a, b) => {
        if (a.severity !== b.severity) return a.severity === "CRITICAL" ? -1 : 1;
        return b.ageHours - a.ageHours;
      });

      const lines = sortedSummaries.map(
        (s) =>
          `• [${s.severity}] ${s.collection}/${s.identifier} — status=${s.status}, age=${s.ageHours}h — ${s.reason}`
      );

      const subject =
        criticalCount > 0
          ? `${criticalCount} CRITICAL + ${warnCount} stuck provisioning record(s)`
          : `${warnCount} stuck provisioning record(s)`;

      const message =
        `Pending provisioning records have been stuck for more than 24 hours. ` +
        `Customers may have paid without receiving the service. Investigate via the admin panel.`;

      serverLogger.warn(`[PendingSweeper] Admin alert:\n${lines.join("\n")}`);

      await EmailService.sendAdminNotification(adminEmail, subject, message, {
        criticalCount,
        warnCount,
        records: sortedSummaries,
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        serverLogger.error(`[PendingSweeper] Failed to send admin alert: ${message}`);
      });
    }

    return secureJsonResponse({
      checked: summaries.length,
      critical: criticalCount,
      warn: warnCount,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    serverLogger.error("[PendingSweeper] Error:", message);
    return secureErrorResponse("Internal error", 500, "INTERNAL_ERROR");
  }
}
