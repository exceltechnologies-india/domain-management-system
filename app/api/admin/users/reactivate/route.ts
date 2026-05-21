import { NextRequest, NextResponse } from "next/server";
import { getUserById, reactivateUser } from "@/lib/services/users";
import { AuthService } from "@/lib/auth";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

// POST - Reactivate a deactivated user (admin only)
export async function POST(request: NextRequest) {
  try {
    const user = await AuthService.getAdminFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { userId } = await request.json();

    if (!userId) {
      return NextResponse.json(
        { error: "User ID is required" },
        { status: 400 }
      );
    }

    // Find the user
    const targetUser = await getUserById(userId);
    if (!targetUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Check if user is actually deactivated
    if (!targetUser.isDeleted) {
      return NextResponse.json(
        { error: "User is not deactivated" },
        { status: 400 }
      );
    }

    // Reactivate the user — clear session invalidation when re-enabled
    const updatedUser = await reactivateUser(userId);

    if (!updatedUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    serverLogger.info(
      `✅ [ADMIN] User reactivated: ${updatedUser.email} by admin: ${user.email}`
    );

    return NextResponse.json({
      success: true,
      message: "User reactivated successfully",
      user: {
        id: updatedUser._id,
        email: updatedUser.email,
        firstName: updatedUser.firstName,
        lastName: updatedUser.lastName,
        isActive: updatedUser.isActive,
      },
    });
  } catch (error) {
    serverLogger.error("Error reactivating user:", error);
    return NextResponse.json(
      { error: "Failed to reactivate user" },
      { status: 500 }
    );
  }
}
