import { NextRequest } from "next/server";
import { AuthService } from "@/lib/auth";
import { changePackage as daChangePackage } from "@/lib/integrations/directadmin";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { validatedBody, z } from "@/lib/api-validation";

const changePackageSchema = z.object({
  username: z.string().trim().min(1, "Username is required").max(100),
  newPackage: z.string().trim().min(1, "New package is required").max(100),
});

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

    const validation = await validatedBody(request, changePackageSchema);
    if (!validation.ok) return validation.response;
    const { username, newPackage } = validation.data;

    serverLogger.info(`Admin changing package for user: ${username} to ${newPackage}`);
    const outcome = await daChangePackage({ username, newPackage });

    switch (outcome.kind) {
      case "changed":
        return secureJsonResponse({
          success: true,
          message: `Package for user '${username}' changed to '${newPackage}' successfully.`,
        });
      case "user_not_found":
        return secureErrorResponse(
          `DirectAdmin reports no such user: ${username}`,
          404,
          "USER_NOT_FOUND"
        );
      case "package_not_found":
        return secureErrorResponse(
          `DirectAdmin reports no such package: ${newPackage}`,
          404,
          "PACKAGE_NOT_FOUND"
        );
      case "da_unreachable":
        return secureErrorResponse(
          "DirectAdmin is temporarily unreachable. Please retry.",
          503,
          "DA_UNREACHABLE"
        );
      case "hard_failure":
        return secureErrorResponse(outcome.reason, 500, "PACKAGE_CHANGE_FAILED");
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to change package";
    serverLogger.error(`Admin Change Package Route Error (${request.headers.get('x-user-email')}):`, message);
    return secureErrorResponse(message, 500, "PACKAGE_CHANGE_FAILED");
  }
}
