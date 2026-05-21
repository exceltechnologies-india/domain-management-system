import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import { getLatestIPCheck } from "@/lib/services/ip-checks";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    await connectDB();

    const user = await AuthService.getAdminFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get the latest IP check result
    const latestIPCheck = await getLatestIPCheck();

    if (!latestIPCheck) {
      return NextResponse.json({
        success: false,
        message: "No IP check data available",
        data: null,
        lastChecked: null,
        checkedBy: null,
      });
    }

    return NextResponse.json({
      success: latestIPCheck.success,
      message: latestIPCheck.message,
      data: latestIPCheck.data,
      error: latestIPCheck.error,
      lastChecked: latestIPCheck.checkedAt,
      checkedBy: latestIPCheck.checkedBy,
    });
  } catch (error) {
    serverLogger.error("Failed to get IP status:", error);
    return NextResponse.json(
      {
        success: false,
        message: "Failed to get IP status",
        error: "Internal server error",
      },
      { status: 500 }
    );
  }
}
