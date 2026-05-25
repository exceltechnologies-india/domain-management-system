import { NextRequest, NextResponse } from "next/server";
import { findAnyAdmin } from "@/lib/services/users";
import bcrypt from "bcryptjs";
import { verifyAdminAuth } from "@/lib/admin-auth";
import { requireReAuth } from "@/lib/admin-security";
import { serverLogger } from "@/lib/server-logger";
import { validatedBody, z } from "@/lib/api-validation";

const adminSelfResetSchema = z
  .object({
    newPassword: z.string().min(8, "Password must be at least 8 characters long").max(256),
    confirmPassword: z.string().min(1, "Confirmation is required"),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    // Verify admin authentication
    const authResult = await verifyAdminAuth(request);
    if (!authResult.valid) {
      return NextResponse.json({ error: authResult.error }, { status: 401 });
    }

    // Step-up auth: current password required before setting a new admin password
    const reauth = await requireReAuth(request, authResult.user!.id);
    if (!reauth.passed) {
      return NextResponse.json(
        { error: "Current password required to reset the admin password", code: "REAUTH_REQUIRED" },
        { status: 403 }
      );
    }

    const validation = await validatedBody(request, adminSelfResetSchema);
    if (!validation.ok) return validation.response;
    const { newPassword } = validation.data;

    // Find admin user
    const adminUser = await findAnyAdmin();
    if (!adminUser) {
      return NextResponse.json(
        { error: "Admin user not found" },
        { status: 404 }
      );
    }

    // Hash new password
    const salt = await bcrypt.genSalt(12);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    // Update admin password
    adminUser.password = hashedPassword;
    await adminUser.save();

    return NextResponse.json({
      message: "Admin password has been reset successfully",
    });
  } catch (error) {
    serverLogger.error("Admin password reset error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
