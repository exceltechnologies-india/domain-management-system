import { NextRequest } from "next/server";
import { AuthService } from "@/lib/auth";
import { DirectAdminService } from "@/lib/directadmin";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import connectDB from "@/lib/mongodb";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const isAdmin = await AuthService.isAdmin(request);
    if (!isAdmin) {
      return secureErrorResponse("Unauthorized", 403, "FORBIDDEN");
    }

    const { usernames } = await request.json();
    
    if (!usernames || !Array.isArray(usernames)) {
        return secureErrorResponse("Array of usernames required", 400, "INVALID_INPUT");
    }

    await connectDB();

    const results: any[] = [];

    for (const username of usernames) {
      try {
        serverLogger.info(`Cleanup: Attempting to delete ${username}`);
        const daResult = await DirectAdminService.deleteUser(username);
        results.push({ username, success: true, daResult });
      } catch (err: any) {
        serverLogger.error(`Cleanup: Failed to delete ${username}: ${err.message}`);
        results.push({ username, success: false, error: err.message });
      }
    }

    return secureJsonResponse({
      success: true,
      data: results
    });
  } catch (error: any) {
    return secureErrorResponse(error.message, 500, "CLEANUP_FAILED");
  }
}
