import { NextRequest } from "next/server";
import { AuthService } from "@/lib/auth";
import { deleteUser as daDeleteUser } from "@/lib/integrations/directadmin";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import connectDB from "@/lib/mongodb";
import { validatedBody, z } from "@/lib/api-validation";

const cleanupSchema = z.object({
  usernames: z
    .array(z.string().trim().min(1).max(100))
    .min(1, "Array of usernames required")
    .max(100, "Cannot clean up more than 100 users in a single request"),
});

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const isAdmin = await AuthService.isAdmin(request);
    if (!isAdmin) {
      return secureErrorResponse("Unauthorized", 403, "FORBIDDEN");
    }

    const validation = await validatedBody(request, cleanupSchema);
    if (!validation.ok) return validation.response;
    const { usernames } = validation.data;

    await connectDB();

    const results: Array<{
      username: string;
      success: boolean;
      outcome: string;
      error?: string;
    }> = [];

    for (const username of usernames) {
      serverLogger.info(`Cleanup: Attempting to delete ${username}`);
      // Coalesce `user_not_found` with `deleted` — for cleanup purposes
      // the end state matches the intent. Other outcomes surface
      // distinctly so admin can tell DA-down apart from real failures.
      const outcome = await daDeleteUser({ username });
      switch (outcome.kind) {
        case "deleted":
        case "user_not_found":
          results.push({ username, success: true, outcome: outcome.kind });
          break;
        case "da_unreachable":
          results.push({
            username,
            success: false,
            outcome: outcome.kind,
            error: "DA temporarily unreachable — try again",
          });
          break;
        case "hard_failure":
          results.push({
            username,
            success: false,
            outcome: outcome.kind,
            error: "Delete failed — see server logs",
          });
          break;
      }
    }

    return secureJsonResponse({
      success: true,
      data: results
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Cleanup failed";
    return secureErrorResponse(message, 500, "CLEANUP_FAILED");
  }
}
