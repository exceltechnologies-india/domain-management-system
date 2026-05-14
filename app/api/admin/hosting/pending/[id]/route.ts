import { NextRequest } from "next/server";
import { AuthService } from "@/lib/auth";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import PendingHosting from "@/models/PendingHosting";
import connectDB from "@/lib/mongodb";

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

    await connectDB();
    


    const deleted = await PendingHosting.findByIdAndDelete(id);

    if (!deleted) {
      return secureErrorResponse("Entry not found", 404, "NOT_FOUND");
    }

    return secureJsonResponse({
      success: true,
      message: "Pending hosting entry deleted successfully"
    });
  } catch (error: any) {
    return secureErrorResponse(error.message, 500, "SERVER_ERROR");
  }
}
