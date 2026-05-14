import { AUTH_SECRET } from "@/lib/auth-secret";
import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { getToken } from "next-auth/jwt";
import connectDB from "@/lib/mongodb";
import IPCheck from "@/models/IPCheck";
import User from "@/models/User";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    await connectDB();

    // Try JWT first, then NextAuth session
    let user = await AuthService.getUserFromRequest(request);

    // If no user from JWT, try NextAuth session via getToken (works with cookies)
    if (!user) {
      const token = await getToken({
        req: request,
        secret: AUTH_SECRET,
      });

      if (token?.id) {
        // Get user by id from NextAuth token
        user = await User.findById(token.id).select("-password");

        if (!user || !user.isActive) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
      }
    }

    // Check admin authentication
    if (!user || user.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get the latest IP check result
    const latestIPCheck = await IPCheck.findOne()
      .sort({ checkedAt: -1 })
      .populate("checkedBy", "firstName lastName email", User);

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
