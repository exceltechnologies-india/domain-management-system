import { NextRequest } from "next/server";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { AuthService } from "@/lib/auth";
import {
  countWatchesForUser,
  listWatchesForUser,
  removeUserWatch,
  upsertUserWatch,
} from "@/lib/services/domain-watches";
import { validatedBody, z } from "@/lib/api-validation";

const addWatchSchema = z.object({
  domainName: z
    .string()
    .trim()
    .toLowerCase()
    .min(3, "Domain name must be at least 3 characters")
    .max(253, "Domain name must be at most 253 characters"),
});

export const dynamic = "force-dynamic";

// GET /api/user/domains/watch — list watched domains for the current user
export async function GET(request: NextRequest) {
  try {
    const user = await AuthService.getUserFromRequest(request);
    if (!user) return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");

    const watches = await listWatchesForUser(String(user._id));
    return secureJsonResponse({ watches });
  } catch (error) {
    return secureErrorResponse("Internal server error", 500, "SERVER_ERROR", error);
  }
}

// POST /api/user/domains/watch — add a domain to watch list
export async function POST(request: NextRequest) {
  try {
    const user = await AuthService.getUserFromRequest(request);
    if (!user) return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");

    const result = await validatedBody(request, addWatchSchema);
    if (!result.ok) return result.response;
    const { domainName } = result.data;

    // Enforce per-user limit to prevent abuse
    const MAX_WATCHES = 20;
    const count = await countWatchesForUser(String(user._id));
    if (count >= MAX_WATCHES) {
      return secureErrorResponse(
        `Watch list limit reached (max ${MAX_WATCHES})`,
        400,
        "WATCH_LIMIT_EXCEEDED"
      );
    }

    const watch = await upsertUserWatch(String(user._id), domainName);
    return secureJsonResponse({ watch }, 201);
  } catch (error: unknown) {
    if ((error as { code?: number }).code === 11000) {
      return secureErrorResponse("Domain already in watch list", 409, "ALREADY_WATCHING");
    }
    return secureErrorResponse("Internal server error", 500, "SERVER_ERROR", error);
  }
}

// DELETE /api/user/domains/watch — remove a domain from watch list
export async function DELETE(request: NextRequest) {
  try {
    const user = await AuthService.getUserFromRequest(request);
    if (!user) return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");

    const { searchParams } = new URL(request.url);
    const domainName = searchParams.get("domain")?.trim().toLowerCase();

    if (!domainName) {
      return secureErrorResponse("Missing domain parameter", 400, "MISSING_DOMAIN");
    }

    const removed = await removeUserWatch(String(user._id), domainName);
    if (!removed) {
      return secureErrorResponse("Watch not found", 404, "NOT_FOUND");
    }

    return secureJsonResponse({ success: true });
  } catch (error) {
    return secureErrorResponse("Internal server error", 500, "SERVER_ERROR", error);
  }
}
