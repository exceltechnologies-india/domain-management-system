import { NextRequest } from "next/server";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { AuthService } from "@/lib/auth";
import { listTicketsForAdmin } from "@/lib/services/support-tickets";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const isAdmin = await AuthService.isAdmin(request);
    if (!isAdmin) return secureErrorResponse("Forbidden", 403, "FORBIDDEN");

    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status") ?? undefined;
    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));

    const result = await listTicketsForAdmin({ status, page, perPage: 25 });

    return secureJsonResponse({
      tickets: result.tickets,
      total: result.total,
      page: result.page,
      pages: result.pages,
    });
  } catch (error) {
    return secureErrorResponse("Internal server error", 500, "SERVER_ERROR", error);
  }
}
