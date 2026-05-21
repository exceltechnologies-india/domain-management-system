import { NextRequest } from "next/server";
import {
  secureJsonResponse,
  secureErrorResponse,
} from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { authorizeCronRequest } from "@/lib/cron-auth";
import {
  listWatchesForCron,
  recordWatchCheck,
  removeWatchById,
} from "@/lib/services/domain-watches";
import { ResellerClubAPI } from "@/lib/resellerclub";
import { EmailService } from "@/lib/email";

export const dynamic = "force-dynamic";

/** Maximum watches to process per run to stay within Cloud Tasks timeout */
const BATCH_SIZE = 100;

/**
 * POST /api/workers/check-domain-watch
 *
 * Called by the daily scheduler. Fetches all DomainWatch records, checks
 * availability against ResellerClub, and sends an email + removes the watch
 * for any domain that has become available.
 *
 * Auth: x-cron-secret header required.
 */
export async function POST(request: NextRequest) {
  try {
    if (!authorizeCronRequest(request)) {
      return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
    }

    const watches = await listWatchesForCron(BATCH_SIZE);

    if (watches.length === 0) {
      return secureJsonResponse({ success: true, checked: 0, notified: 0 });
    }

    const results = { checked: 0, notified: 0, errors: 0 };

    // RC `searchDomain` is the bottleneck; chunk-of-5 keeps us inside RC's
    // rate-limit window while turning 100 serial calls (~30s) into ~6s.
    const WATCH_CONCURRENCY = 5;
    for (let i = 0; i < watches.length; i += WATCH_CONCURRENCY) {
      const chunk = watches.slice(i, i + WATCH_CONCURRENCY);
      const outcomes = await Promise.allSettled(
        chunk.map(async (watch) => {
          const searchResults = await ResellerClubAPI.searchDomain(watch.domainName);
          const match = searchResults.find(
            (r) => r.domainName.toLowerCase() === watch.domainName.toLowerCase()
          );

          const isAvailable = match?.available === true;
          const newStatus = isAvailable ? "available" : "taken";

          await recordWatchCheck(String(watch._id), newStatus);

          // userId is populated (.populate('userId', …)) so it's the object form.
          const user = watch.userId as unknown as
            | { email?: string; firstName?: string; lastName?: string }
            | undefined;
          if (!isAvailable || !user?.email) {
            return { notified: false } as const;
          }

          // Domain just became available — notify once then remove the watch
          const userName = user.firstName
            ? `${user.firstName} ${user.lastName ?? ""}`.trim()
            : undefined;

          await EmailService.sendDomainAvailableEmail(
            user.email,
            watch.domainName,
            userName
          ).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            serverLogger.error(
              `[DomainWatch] Email failed for ${watch.domainName}: ${message}`
            );
          });

          // Remove watch so the user only gets one notification
          await removeWatchById(String(watch._id));

          serverLogger.info(
            `[DomainWatch] Notified ${user.email} — ${watch.domainName} is available`
          );
          return { notified: true } as const;
        })
      );

      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          const message = outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason);
          serverLogger.error(`[DomainWatch] Check failed: ${message}`);
          results.errors++;
          continue;
        }
        results.checked++;
        if (outcome.value.notified) results.notified++;
      }
    }

    serverLogger.info(
      `[DomainWatch] Run complete — checked ${results.checked}, notified ${results.notified}, errors ${results.errors}`
    );

    return secureJsonResponse({ success: true, ...results });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    serverLogger.error("[DomainWatch] Worker error:", message);
    return secureErrorResponse("Internal error", 500, "INTERNAL_ERROR");
  }
}
