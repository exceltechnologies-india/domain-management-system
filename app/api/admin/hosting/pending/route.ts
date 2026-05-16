export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";

import { AuthService } from "@/lib/auth";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { listPendingHostingsForAdmin } from "@/lib/services/pending-hostings";

export async function GET(request: NextRequest) {
  try {
    const isAdmin = await AuthService.isAdmin(request);
    if (!isAdmin) {
      return secureErrorResponse("Unauthorized", 403, "FORBIDDEN");
    }

    const pendingHostings = await listPendingHostingsForAdmin();

    return secureJsonResponse({
      success: true,
      data: pendingHostings
    });
  } catch (error: any) {
    return secureErrorResponse(error.message, 500, "SERVER_ERROR");
  }
}
