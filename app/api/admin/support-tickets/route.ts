import { NextRequest } from "next/server";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { AuthService } from "@/lib/auth";
import { getDspTicketsForAdmin } from "@/lib/integrations/support-tickets-admin";

export const dynamic = "force-dynamic";

// Support Panel (DSP) only — legacy Mongo tickets dropped from this view per
// request. lib/services/support-tickets.ts and the [id] detail page are left
// in place (unused by this route) rather than deleted.
export async function GET(request: NextRequest) {
  try {
    const isAdmin = await AuthService.isAdmin(request);
    if (!isAdmin) return secureErrorResponse("Forbidden", 403, "FORBIDDEN");

    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") ?? "all";

    const tickets = await getDspTicketsForAdmin(status);

    return secureJsonResponse({
      tickets,
      total: tickets.length,
      page: 1,
      pages: 1,
    });
  } catch (error) {
    return secureErrorResponse("Internal server error", 500, "SERVER_ERROR", error);
  }
}
