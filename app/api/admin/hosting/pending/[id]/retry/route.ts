import { NextRequest } from "next/server";
import { AuthService } from "@/lib/auth";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import {
  getPendingHostingById,
  provisionPendingHosting,
} from "@/lib/services/pending-hostings";

/**
 * POST /api/admin/hosting/pending/[id]/retry
 *
 * Manual admin retry for a stuck PendingHosting row. Delegates to
 * {@link provisionPendingHosting} — the same code path the auto-retry cron
 * runs, so admin-triggered + cron-triggered retries stay in sync.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const isAdmin = await AuthService.isAdmin(request);
    if (!isAdmin) {
      return secureErrorResponse("Unauthorized. Admin access required.", 403, "FORBIDDEN");
    }

    const pendingEntry = await getPendingHostingById(id);
    if (!pendingEntry) {
      return secureErrorResponse("Pending entry not found", 404, "NOT_FOUND");
    }

    serverLogger.info(
      `[AdminRetry] Retrying pending hosting ${pendingEntry.domain} (user: ${pendingEntry.userId})`
    );

    const result = await provisionPendingHosting(pendingEntry);

    if (!result.ok) {
      return secureErrorResponse(
        result.error || "Retry failed",
        500,
        "PROVISION_RETRY_FAILED"
      );
    }

    return secureJsonResponse({
      success: true,
      message: result.dropped
        ? "User already had hosting elsewhere — pending entry cleared."
        : `Hosting provisioned for ${pendingEntry.domain}. Pending entry removed.`,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to retry provision";
    serverLogger.error("Admin Hosting Retry Error:", message);
    return secureErrorResponse(message, 500, "PROVISION_RETRY_FAILED");
  }
}
