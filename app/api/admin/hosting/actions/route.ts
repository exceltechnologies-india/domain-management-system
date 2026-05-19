import { NextRequest } from "next/server";
import { AuthService } from "@/lib/auth";
import { DirectAdminService } from "@/lib/directadmin";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import connectDB from "@/lib/mongodb";
import { clearDirectAdminUsernameForAll } from "@/lib/services/users";
import Hosting from "@/models/Hosting";
import { RazorpayService } from "@/lib/razorpay";

export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/hosting/actions
 * Perform administrative actions on hosting accounts (suspend, unsuspend, delete).
 * Restricted to Admins only.
 */
export async function POST(request: NextRequest) {
  try {
    // 1. Authenticate and check Admin role
    const isAdmin = await AuthService.isAdmin(request);
    if (!isAdmin) {
      return secureErrorResponse("Unauthorized. Admin access required.", 403, "FORBIDDEN");
    }

    // 2. Parse payload
    const body = await request.json();
    const { action, username, hostingId } = body;

    if (!action || (!username && !hostingId)) {
      return secureErrorResponse("Missing action, username or hostingId", 400, "INVALID_PAYLOAD");
    }

    serverLogger.info(`Admin performing '${action}' on DA user: ${username || 'N/A'} (Hosting ID: ${hostingId || 'N/A'})`);

    let result;

    // 3. Perform Action
    switch (action) {
      case 'suspend':
        result = await DirectAdminService.suspendUser(username);
        break;
      
      case 'unsuspend':
        result = await DirectAdminService.unsuspendUser(username);
        break;
      
      case 'delete':
        // For delete, we also need to clear the local records
        // to keep states consistent (even if DA user is already gone).
        
        // Update local DB
        await connectDB();

        // 1. Check for active subscription(s) and cancel them
        const query = hostingId ? { _id: hostingId } : { directAdminUsername: username };
        const hostingRecords = await Hosting.find(query);
        
        for (const record of hostingRecords) {
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

        // 2. Delete ALL matching Hosting records from local DB
        const deleteHostingResult = await Hosting.deleteMany(query);
        serverLogger.info(`Permanently deleted ${deleteHostingResult.deletedCount} Hosting record(s) for ${username || 'N/A'} (ID: ${hostingId || 'N/A'}) from local DB`);

        // 3. Clear any PendingHosting records
        if (username) {
          const { deletePendingHostingsByUsername } = await import("@/lib/services/pending-hostings");
          const cleared = await deletePendingHostingsByUsername(username);
          if (cleared > 0) {
            serverLogger.info(`Cleared ${cleared} PendingHosting record(s)`);
          }
        }

        // 4. Delete from DirectAdmin (External) - Make this resilient
        if (username && username !== 'N/A') {
          try {
            result = await DirectAdminService.deleteUser(username);
          } catch (daError: unknown) {
            const message = daError instanceof Error ? daError.message : String(daError);
            serverLogger.warn(`DirectAdmin deletion failed for ${username}, but proceeding with local cleanup: ${message}`);
            result = { warning: `DA deletion failed: ${message}. Local records were cleared.` };
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
    const message = error instanceof Error ? error.message : "Failed to perform hosting action";
    serverLogger.error(`Admin Hosting Action Error (${request.url}):`, message);
    return secureErrorResponse(
      message,
      500,
      "ACTION_FAILED"
    );
  }
}
