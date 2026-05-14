export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";

import { AuthService } from "@/lib/auth";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import PendingHosting from "@/models/PendingHosting";
import connectDB from "@/lib/mongodb";

export async function GET(request: NextRequest) {
  try {
    const isAdmin = await AuthService.isAdmin(request);
    if (!isAdmin) {
      return secureErrorResponse("Unauthorized", 403, "FORBIDDEN");
    }

    await connectDB();
    
    const pendingHostings = await PendingHosting.find({})
      .populate('userId', 'name email')
      .sort({ createdAt: -1 });

    return secureJsonResponse({
      success: true,
      data: pendingHostings
    });
  } catch (error: any) {
    return secureErrorResponse(error.message, 500, "SERVER_ERROR");
  }
}
