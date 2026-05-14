import { NextRequest, NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import User from "@/models/User";
import { AuthService } from "@/lib/auth";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

// GET - Fetch all deactivated users (admin only)
export async function GET(request: NextRequest) {
  try {
    // Verify admin authentication
    const user = await AuthService.getUserFromRequest(request);

    if (!user || user.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await connectDB();

    // Fetch only deactivated users (exclude admin users for security)
    const users = await User.find(
      {
        role: { $ne: "admin" }, // Exclude admin users
        isDeleted: true, // Only deactivated users
      },
      {
        firstName: 1,
        lastName: 1,
        email: 1,
        role: 1,
        createdAt: 1,
        isActive: 1,
        isDeleted: 1,
        deletedAt: 1,
      }
    ).sort({ deletedAt: -1 }); // Sort by deletion date, most recent first

    return NextResponse.json({
      success: true,
      users: users.map((user) => ({
        _id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        createdAt: (user as any).createdAt,
        isActive: user.isActive,
        isDeleted: user.isDeleted,
        deletedAt: user.deletedAt,
      })),
    });
  } catch (error) {
    serverLogger.error("Error fetching deactivated users:", error);
    return NextResponse.json(
      { error: "Failed to fetch deactivated users" },
      { status: 500 }
    );
  }
}
