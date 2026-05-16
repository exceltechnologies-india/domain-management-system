import { NextRequest } from "next/server";
import {
  secureJsonResponse,
  secureErrorResponse,
} from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
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
    const authHeader = request.headers.get("x-cron-secret");
    if (!authHeader || authHeader !== process.env.CRON_SECRET) {
      return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
    }

    const watches = await listWatchesForCron(BATCH_SIZE);

    if (watches.length === 0) {
      return secureJsonResponse({ success: true, checked: 0, notified: 0 });
    }

    const results = { checked: 0, notified: 0, errors: 0 };

    for (const watch of watches) {
      try {
        const searchResults = await ResellerClubAPI.searchDomain(watch.domainName);
        const match = searchResults.find(
          (r) => r.domainName.toLowerCase() === watch.domainName.toLowerCase()
        );

        const isAvailable = match?.available === true;
        const newStatus = isAvailable ? "available" : "taken";

        await recordWatchCheck(String(watch._id), newStatus);

        results.checked++;

        const user = watch.userId as any;
        if (!isAvailable || !user?.email) continue;

        // Domain just became available — notify once then remove the watch
        const userName = user.firstName
          ? `${user.firstName} ${user.lastName ?? ""}`.trim()
          : undefined;

        await EmailService.sendDomainAvailableEmail(
          user.email,
          watch.domainName,
          userName
        ).catch((err: any) =>
          serverLogger.error(
            `[DomainWatch] Email failed for ${watch.domainName}: ${err.message}`
          )
        );

        // Remove watch so the user only gets one notification
        await removeWatchById(String(watch._id));

        results.notified++;
        serverLogger.info(
          `[DomainWatch] Notified ${user.email} — ${watch.domainName} is available`
        );
      } catch (err: any) {
        serverLogger.error(
          `[DomainWatch] Error checking ${watch.domainName}: ${err.message}`
        );
        results.errors++;
      }
    }

    serverLogger.info(
      `[DomainWatch] Run complete — checked ${results.checked}, notified ${results.notified}, errors ${results.errors}`
    );

    return secureJsonResponse({ success: true, ...results });
  } catch (error: any) {
    serverLogger.error("[DomainWatch] Worker error:", error.message);
    return secureErrorResponse("Internal error", 500, "INTERNAL_ERROR");
  }
}
