import { NextRequest } from "next/server";
import crypto from "crypto";
import connectDB from "@/lib/mongodb";
import User from "@/models/User";
import { AuthService } from "@/lib/auth";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { sendEmail } from "@/lib/email/transporter";

export const dynamic = "force-dynamic";

const EMAIL_CHANGE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * POST /api/user/settings/change-email
 * Body: { newEmail, currentPassword }
 *
 * Initiates a secure email change:
 *   1. Verifies current password (prevents ATO via stolen session)
 *   2. Stores a hashed verification token against the pending new address
 *   3. Sends a confirmation link to the NEW address
 *   4. Sends a security alert to the OLD address
 */
export async function POST(request: NextRequest) {
  try {
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
    }

    // Social-login accounts have no password — block email changes for them
    if (user.provider && user.provider !== "credentials") {
      return secureErrorResponse(
        "Email cannot be changed for social login accounts",
        400,
        "SOCIAL_ACCOUNT"
      );
    }

    const body = await request.json();
    const { newEmail, currentPassword } = body;

    if (!newEmail || typeof newEmail !== "string") {
      return secureErrorResponse("newEmail is required", 400, "MISSING_FIELD");
    }
    if (!currentPassword || typeof currentPassword !== "string") {
      return secureErrorResponse("currentPassword is required", 400, "MISSING_FIELD");
    }

    const normalizedEmail = newEmail.trim().toLowerCase();

    // Basic email format check
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254) {
      return secureErrorResponse("Invalid email address", 400, "INVALID_EMAIL");
    }

    if (normalizedEmail === user.email.toLowerCase()) {
      return secureErrorResponse(
        "New email must be different from current email",
        400,
        "SAME_EMAIL"
      );
    }

    await connectDB();

    // Re-fetch with password field (select: false by default)
    const userWithPassword = await User.findById(user._id).select("+password");
    if (!userWithPassword?.password) {
      return secureErrorResponse("Cannot verify identity", 400, "NO_PASSWORD");
    }

    const passwordValid = await userWithPassword.comparePassword(currentPassword);
    if (!passwordValid) {
      return secureErrorResponse("Incorrect current password", 401, "INVALID_PASSWORD");
    }

    // Check new email is not already registered
    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      // Return the same message as success to avoid email enumeration
      return secureJsonResponse({
        message: "If that address is available, a verification link has been sent to it.",
      });
    }

    // Generate a 32-byte cryptographically random token
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    userWithPassword.pendingEmail = normalizedEmail;
    userWithPassword.pendingEmailToken = tokenHash;
    userWithPassword.pendingEmailExpiry = new Date(Date.now() + EMAIL_CHANGE_TTL_MS);
    await userWithPassword.save();

    const appUrl = process.env.NEXTAUTH_URL ?? "https://app.anutech.in";
    const verifyUrl = `${appUrl}/api/user/settings/verify-email-change?token=${rawToken}`;
    const userName = `${userWithPassword.firstName || ""} ${userWithPassword.lastName || ""}`.trim() || userWithPassword.email;

    // 1. Verification link → new address
    await sendEmail({
      to: normalizedEmail,
      subject: "Confirm your new email address – Anutech Digital",
      html: `
        <p>Hi ${userName},</p>
        <p>You requested to change your email address on Anutech Digital.</p>
        <p>Click the button below to confirm this new address. The link expires in <strong>1 hour</strong>.</p>
        <p><a href="${verifyUrl}" style="display:inline-block;padding:12px 24px;background:#1d4ed8;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Confirm new email</a></p>
        <p>If you didn't request this change, you can safely ignore this email. Your current address remains active.</p>
        <p>– Anutech Digital Team</p>
      `,
    });

    // 2. Security alert → current (old) address
    await sendEmail({
      to: userWithPassword.email,
      subject: "Security alert: Email change requested – Anutech Digital",
      html: `
        <p>Hi ${userName},</p>
        <p>A request was made to change the email address on your Anutech Digital account to <strong>${normalizedEmail}</strong>.</p>
        <p>If this was you, please check your new inbox and click the confirmation link we sent there.</p>
        <p>If you did <strong>not</strong> make this request, your account may be compromised. Please <a href="${appUrl}/reset-password">reset your password immediately</a> and contact support.</p>
        <p>– Anutech Digital Team</p>
      `,
    });

    serverLogger.info(`[EMAIL-CHANGE] Verification email sent for user ...${String(userWithPassword._id).slice(-6)}`);

    return secureJsonResponse({
      message: "If that address is available, a verification link has been sent to it.",
    });
  } catch (error: any) {
    serverLogger.error("[EMAIL-CHANGE] Error:", error.message || error);
    return secureErrorResponse("Failed to initiate email change", 500, "INTERNAL_ERROR");
  }
}
