import { AUTH_SECRET } from "@/lib/auth-secret";
import { NextRequest, NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import { getUserById, getUserByIdSafe } from "@/lib/services/users";
import User from "@/models/User";
import { AuthService } from "@/lib/auth";
import { getToken } from "next-auth/jwt";
import bcrypt from "bcryptjs";
import { EmailService } from "@/lib/email";
import { requireReAuth } from "@/lib/admin-security";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    await connectDB();

    // Verify admin authentication - Try JWT first, then NextAuth session
    let user = await AuthService.getUserFromRequest(request);
    
    // If no user from JWT, try NextAuth session via getToken (works with cookies)
    if (!user) {
      const token = await getToken({ 
        req: request,
        secret: AUTH_SECRET,
      });
      
      if (token?.id) {
        // Get user by id from NextAuth token
        user = await getUserByIdSafe(token.id);
        
        if (!user || !user.isActive) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
      }
    }

    // Check if user is admin
    if (!user || user.role !== "admin") {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }

    // Step-up auth: current password required before resetting another user's password
    const adminId = (user._id as any)?.toString() || user.id || "";
    const reauth = await requireReAuth(request, adminId);
    if (!reauth.passed) {
      return NextResponse.json(
        { error: "Current password required to reset a user password", code: "REAUTH_REQUIRED" },
        { status: 403 }
      );
    }

    const { userId, newPassword, sendEmail = true } = await request.json();

    if (!userId || !newPassword) {
      return NextResponse.json(
        { error: "User ID and new password are required" },
        { status: 400 }
      );
    }

    if (newPassword.length < 6) {
      return NextResponse.json(
        { error: "Password must be at least 6 characters long" },
        { status: 400 }
      );
    }

    // Find the target user
    const targetUser = await getUserById(userId);
    if (!targetUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Prevent admin from resetting another admin's password
    if (targetUser.role === "admin") {
      return NextResponse.json(
        { error: "Cannot reset admin user passwords" },
        { status: 403 }
      );
    }

    // Prevent admin from resetting their own password through this endpoint
    if (user._id?.toString() === userId) {
      return NextResponse.json(
        { error: "Use the admin settings to reset your own password" },
        { status: 400 }
      );
    }

    // Hash the new password
    const salt = await bcrypt.genSalt(12);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    // Update user password
    targetUser.password = hashedPassword;
    
    // Clear any existing reset tokens
    targetUser.resetToken = undefined;
    targetUser.resetTokenExpiry = undefined;
    
    await targetUser.save();

    // Send email notification to user if requested
    if (sendEmail) {
      try {
        await EmailService.sendPasswordResetNotificationEmail(
          targetUser.email,
          `${targetUser.firstName} ${targetUser.lastName}`,
          newPassword
        );
      } catch (emailError) {
        serverLogger.error("Failed to send password reset notification email:", emailError);
        // Don't fail the request if email fails
      }
    }

    return NextResponse.json({
      success: true,
      message: "User password has been reset successfully",
      emailSent: sendEmail,
    });
  } catch (error) {
    serverLogger.error("Admin user password reset error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
