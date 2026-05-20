import { NextRequest } from "next/server";
import { AuthService } from "@/lib/auth";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { deletePendingHostingById } from "@/lib/services/pending-hostings";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const isAdmin = await AuthService.isAdmin(request);
    if (!isAdmin) {
      return secureErrorResponse("Unauthorized", 403, "FORBIDDEN");
    }

    const deleted = await deletePendingHostingById(id);

    if (!deleted) {
      return secureErrorResponse("Entry not found", 404, "NOT_FOUND");
    }

    return secureJsonResponse({
      success: true,
      message: "Pending hosting entry deleted successfully"
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Server error";
    return secureErrorResponse(message, 500, "SERVER_ERROR");
  }
}
