import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { DirectAdminService } from "@/lib/directadmin";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";

/**
 * POST /api/admin/hosting/change-package
 * Changes the hosting package for a user in DirectAdmin.
 * Restricted to Admins only.
 */
export async function POST(request: NextRequest) {
  try {
    // 1. Authenticate and check Admin role
    const isAdmin = await AuthService.isAdmin(request);
    if (!isAdmin) {
      serverLogger.warn("Admin Change Package Attempt: Unauthorized access");
      return secureErrorResponse("Unauthorized. Admin access required.", 403, "FORBIDDEN");
    }

    // 2. Parse request body
    const body = await request.json();
    const { username, newPackage } = body;

    if (!username || !newPackage) {
      return secureErrorResponse("Username and new package are required.", 400, "INVALID_INPUT");
    }

    // 3. Change package via DirectAdmin API
    serverLogger.info(`Admin changing package for user: ${username} to ${newPackage}`);
    await DirectAdminService.changePackage(username, newPackage);

    return secureJsonResponse({ 
      success: true, 
      message: `Package for user '${username}' changed to '${newPackage}' successfully.`
    });
  } catch (error: any) {
    serverLogger.error(`Admin Change Package Route Error (${request.headers.get('x-user-email')}):`, error.message);
    return secureErrorResponse(
      error.message || "Failed to change package",
      500,
      "PACKAGE_CHANGE_FAILED"
    );
  }
}
