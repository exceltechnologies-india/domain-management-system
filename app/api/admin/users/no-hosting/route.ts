import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { listEligibleUsersForAdminPicker } from "@/lib/services/users";

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/users/no-hosting
 * Fetches all users who do not have a DirectAdmin hosting account yet.
 * Restricted to Admins only.
 */
export async function GET(request: NextRequest) {
  try {
    // 1. Authenticate and check Admin role
    const isAdmin = await AuthService.isAdmin(request);
    if (!isAdmin) {
      return secureErrorResponse("Unauthorized. Admin access required.", 403, "FORBIDDEN");
    }

    // The "no-hosting" route name is legacy — it now serves "eligible-for-hosting".
    // Admins pick from this list to provision additional accounts for any user.
    const users = await listEligibleUsersForAdminPicker();

    const formattedUsers = users.map(u => ({
        id: u._id,
        name: `${u.firstName} ${u.lastName}`,
        email: u.email
    }));

    return secureJsonResponse({ 
      success: true, 
      data: formattedUsers
    });

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    serverLogger.error(`Admin Users No-Hosting Error:`, message);
    return secureErrorResponse(
      "Failed to fetch users",
      500,
      "USERS_FETCH_FAILED"
    );
  }
}
