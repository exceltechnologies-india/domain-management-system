import { NextRequest } from "next/server";
import { AuthService } from "@/lib/auth";
import { DirectAdminService } from "@/lib/directadmin";
import { deleteUser as daDeleteUser } from "@/lib/integrations/directadmin";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { listAllHostingsForDirectAdminDiag } from "@/lib/services/hostings";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/diag-da
 * Diagnostic tool to investigate DA license and orphan accounts.
 */
export async function GET(request: NextRequest) {
  try {
    const isAdmin = await AuthService.isAdmin(request);
    if (!isAdmin) {
      return secureErrorResponse("Unauthorized", 403, "FORBIDDEN");
    }

    const url = new URL(request.url);
    const doCleanup = url.searchParams.get("cleanup") === "true";

    serverLogger.info(`DA diagnostics requested. Cleanup mode: ${doCleanup}`);

    // If cleanup requested, do it first
    const cleanupResults = [];
    if (doCleanup) {
      const orphans = ["ttgr6jne", "ttgrgm6jme", "ttgrgm6jme1"];
      for (const username of orphans) {
        const outcome = await daDeleteUser({ username });
        if (outcome.kind === "deleted" || outcome.kind === "user_not_found") {
          cleanupResults.push({ username, status: outcome.kind });
        } else {
          cleanupResults.push({
            username,
            status: outcome.kind,
            error: outcome.kind === "da_unreachable"
              ? "DA unreachable"
              : "delete failed — see server logs",
          });
        }
      }
    }

    // 1. Get Summary Info
    const [users, resellers, license, sysInfo] = await Promise.allSettled([
      DirectAdminService.listUsers(),
      DirectAdminService.listResellers(),
      DirectAdminService.getLicenseInfo(),
      DirectAdminService.getServerInfo(),
    ]);

    // 2. Fetch Hosting records from DB for cross-reference
    const dbHostings = await listAllHostingsForDirectAdminDiag();

    const settledError = (r: PromiseSettledResult<unknown>): { error: string } => ({
      error:
        r.status === "rejected"
          ? r.reason instanceof Error
            ? r.reason.message
            : String(r.reason)
          : "",
    });

    const result = {
      users: users.status === "fulfilled" ? users.value : settledError(users),
      resellers: resellers.status === "fulfilled" ? resellers.value : settledError(resellers),
      license: license.status === "fulfilled" ? license.value : settledError(license),
      system: sysInfo.status === "fulfilled" ? sysInfo.value : settledError(sysInfo),
      database: dbHostings,
      cleanupResults: doCleanup ? cleanupResults : undefined
    };

    serverLogger.info("DA Diagnostics completed.");

    return secureJsonResponse({
      success: true,
      data: result
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    serverLogger.error("DA Diagnostics Route Error:", message);
    return secureErrorResponse(message, 500, "DIAG_FAILED");
  }
}
