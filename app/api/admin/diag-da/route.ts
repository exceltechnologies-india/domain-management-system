import { NextRequest } from "next/server";
import { AuthService } from "@/lib/auth";
import { DirectAdminService } from "@/lib/directadmin";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import connectDB from "@/lib/mongodb";
import Hosting from "@/models/Hosting";

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

    await connectDB();

    const url = new URL(request.url);
    const doCleanup = url.searchParams.get("cleanup") === "true";

    serverLogger.info(`DA diagnostics requested. Cleanup mode: ${doCleanup}`);

    // If cleanup requested, do it first
    const cleanupResults = [];
    if (doCleanup) {
      const orphans = ["ttgr6jne", "ttgrgm6jme", "ttgrgm6jme1"];
      for (const username of orphans) {
        try {
          await DirectAdminService.deleteUser(username);
          cleanupResults.push({ username, status: "deleted" });
        } catch (e: any) {
          cleanupResults.push({ username, status: "failed/not found", error: e.message });
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
    const dbHostings = await Hosting.find({}, "directAdminUsername domainName status");

    const result = {
      users: users.status === "fulfilled" ? users.value : { error: (users as any).reason.message },
      resellers: resellers.status === "fulfilled" ? resellers.value : { error: (resellers as any).reason.message },
      license: license.status === "fulfilled" ? license.value : { error: (license as any).reason.message },
      system: sysInfo.status === "fulfilled" ? sysInfo.value : { error: (sysInfo as any).reason.message },
      database: dbHostings,
      cleanupResults: doCleanup ? cleanupResults : undefined
    };

    serverLogger.info("DA Diagnostics completed.");

    return secureJsonResponse({
      success: true,
      data: result
    });
  } catch (error: any) {
    serverLogger.error("DA Diagnostics Route Error:", error.message);
    return secureErrorResponse(error.message, 500, "DIAG_FAILED");
  }
}
