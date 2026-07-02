import { NextRequest } from "next/server";
import { AuthService } from "@/lib/auth";
import {
  suspendUser as daSuspendUser,
  unsuspendUser as daUnsuspendUser,
  deleteUser as daDeleteUser,
} from "@/lib/integrations/directadmin";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { clearDirectAdminUsernameForAll } from "@/lib/services/users";
import { deleteHostingsByIdOrUsername } from "@/lib/services/hostings";
import { RazorpayService } from "@/lib/razorpay";
import { validatedBody, z } from "@/lib/api-validation";
import { authorizeCronRequest } from "@/lib/cron-auth";

// Discriminated union per action. suspend/unsuspend require username
// (the typed DA wrappers can't operate without it — the previous
// `any`-typed body silently passed `username: undefined` and crashed
// at the wrapper boundary). delete accepts either username or hostingId
// since the local row can be resolved by either.
const hostingActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("suspend"),
    username: z.string().trim().min(1).max(100),
    hostingId: z.string().trim().min(1).optional(),
  }),
  z.object({
    action: z.literal("unsuspend"),
    username: z.string().trim().min(1).max(100),
    hostingId: z.string().trim().min(1).optional(),
  }),
  z
    .object({
      action: z.literal("delete"),
      username: z.string().trim().min(1).max(100).optional(),
      hostingId: z.string().trim().min(1).optional(),
    })
    .refine((d) => Boolean(d.username || d.hostingId), {
      message: "Either username or hostingId is required for delete",
      path: ["username"],
    }),
]);

export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/hosting/actions
 * Perform administrative actions on hosting accounts (suspend, unsuspend, delete).
 * Two auth paths, either sufficient:
 *   1. Admin session cookie (from the /admin dashboard UI in a browser).
 *   2. `x-cron-secret` header matching CRON_SECRET (for scripts/purge-test-users.js
 *      and future machine-authored operator scripts). Added 2026-07-02 because
 *      operator machines aren't whitelisted at DirectAdmin's 4 filter layers —
 *      only the Cloud Run NAT egress IP is. Direct DA API calls from local
 *      always 401, so the purge script needs to route DA deletes through the
 *      production route (which runs on Cloud Run's whitelisted IP). See
 *      [[project_da_whitelist_layers]] + TASKS.md ADMIN-ACTIONS-CRON-AUTH.
 */
export async function POST(request: NextRequest) {
  try {
    // 1. Authenticate: cron-secret header OR admin session cookie.
    const isCron = authorizeCronRequest(request);
    if (!isCron) {
      const isAdmin = await AuthService.isAdmin(request);
      if (!isAdmin) {
        return secureErrorResponse("Unauthorized. Admin access required.", 403, "FORBIDDEN");
      }
    }

    const validation = await validatedBody(request, hostingActionSchema);
    if (!validation.ok) return validation.response;
    const { action, username, hostingId } = validation.data;

    serverLogger.info(`Admin performing '${action}' on DA user: ${username || 'N/A'} (Hosting ID: ${hostingId || 'N/A'})`);

    let result;

    // 3. Perform Action. Each typed-wrapper outcome is rolled up
    // into the `result` field for the response. user_not_found is
    // surfaced explicitly so admin knows the local row was orphaned
    // (DA didn't know the user) vs the operation actually completing.
    switch (action) {
      case 'suspend': {
        const outcome = await daSuspendUser({ username });
        if (outcome.kind === "da_unreachable" || outcome.kind === "hard_failure") {
          return secureErrorResponse(
            outcome.kind === "da_unreachable"
              ? "DA temporarily unreachable — try again"
              : "Suspend failed — see server logs",
            outcome.kind === "da_unreachable" ? 503 : 500,
            outcome.kind === "da_unreachable" ? "DA_UNREACHABLE" : "ACTION_FAILED"
          );
        }
        result = { outcome: outcome.kind };
        break;
      }

      case 'unsuspend': {
        const outcome = await daUnsuspendUser({ username });
        if (outcome.kind === "da_unreachable" || outcome.kind === "hard_failure") {
          return secureErrorResponse(
            outcome.kind === "da_unreachable"
              ? "DA temporarily unreachable — try again"
              : "Unsuspend failed — see server logs",
            outcome.kind === "da_unreachable" ? 503 : 500,
            outcome.kind === "da_unreachable" ? "DA_UNREACHABLE" : "ACTION_FAILED"
          );
        }
        result = { outcome: outcome.kind };
        break;
      }

      case 'delete':
        // For delete, we also need to clear the local records
        // to keep states consistent (even if DA user is already gone).

        // 1. Match local rows, cancel their subscriptions, then delete.
        // Service helper returns matchedHostings (pre-delete snapshot) so the
        // loop below can iterate over them even after the rows are gone.
        const { deletedCount, matchedHostings } = await deleteHostingsByIdOrUsername({
          hostingId,
          directAdminUsername: username,
        });

        for (const record of matchedHostings) {
          if (record.subscriptionId) {
            try {
               serverLogger.info(`Cancelling Razorpay subscription ${record.subscriptionId} for user ${username || record.directAdminUsername}`);
               await RazorpayService.cancelSubscription(record.subscriptionId);
            } catch (err: unknown) {
               const message = err instanceof Error ? err.message : String(err);
               serverLogger.error(`Failed to cancel subscription for ${username || record.directAdminUsername}:`, message);
            }
          }
        }

        serverLogger.info(`Permanently deleted ${deletedCount} Hosting record(s) for ${username || 'N/A'} (ID: ${hostingId || 'N/A'}) from local DB`);

        // 3. Clear any PendingHosting records
        if (username) {
          const { deletePendingHostingsByUsername } = await import("@/lib/services/pending-hostings");
          const cleared = await deletePendingHostingsByUsername(username);
          if (cleared > 0) {
            serverLogger.info(`Cleared ${cleared} PendingHosting record(s)`);
          }
        }

        // 4. Delete from DirectAdmin (External) - resilient: any
        // outcome other than `deleted` / `user_not_found` is logged
        // but doesn't fail the request, since local records are
        // already cleaned up.
        if (username && username !== 'N/A') {
          const outcome = await daDeleteUser({ username });
          if (outcome.kind === "deleted" || outcome.kind === "user_not_found") {
            result = { outcome: outcome.kind };
          } else {
            serverLogger.warn(
              `DirectAdmin deletion ${outcome.kind} for ${username}, but proceeding with local cleanup`
            );
            result = {
              warning: `DA deletion ${outcome.kind}. Local records were cleared.`,
              outcome: outcome.kind,
            };
          }
        }
        
        // 5. Remove mapping from User(s)
        if (username && username !== 'N/A') {
          await clearDirectAdminUsernameForAll(username);
          serverLogger.info(`Removed DA mapping for user ${username} from all local User records`);
        }
        break;

      default:
        return secureErrorResponse("Invalid action. Supported: suspend, unsuspend, delete", 400, "INVALID_ACTION");
    }

    return secureJsonResponse({
      success: true,
      message: `Action '${action}' completed successfully for user ${username}`,
      data: result
    });

  } catch (error: unknown) {
    // Log the real message internally but return a generic one to the client.
    // DA / Mongo / Razorpay error strings can carry credential or
    // internal-host fragments that don't belong even in an admin response.
    const message = error instanceof Error ? error.message : "Failed to perform hosting action";
    serverLogger.error(`Admin Hosting Action Error (${request.url}):`, message);
    return secureErrorResponse(
      "Hosting action failed. Check server logs for details.",
      500,
      "ACTION_FAILED"
    );
  }
}
