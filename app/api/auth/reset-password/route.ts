import { NextRequest, NextResponse } from "next/server";
import { findUserByResetToken } from "@/lib/services/users";
import { Schemas } from "@/lib/validation";
import { SecurityValidator } from "@/lib/security";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 1 - CSRF Protection
     */
    const csrfCheck = SecurityValidator.validateCSRF(request);
    if (!csrfCheck.isValid) {
      return secureErrorResponse(csrfCheck.error || "CSRF Validation Failed", 403, "CSRF_ERROR");
    }

    const body = await request.json();

    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 2 - Zod Validation
     * Strictly validates the reset token and the new password.
     */
    const result = Schemas.resetPassword.safeParse(body);
    if (!result.success) {
      // Extract the first error message for better user feedback
      const firstError = result.error.issues[0]?.message || "Invalid reset data";
      return secureErrorResponse(firstError, 400, "VALIDATION_ERROR", result.error.format());
    }

    const { token, password } = result.data;

    // reCAPTCHA was removed on 2026-06-17 ahead of a fresh re-install. The
    // single-use reset token (256-bit, ~1-hour TTL) below is the primary
    // anti-abuse gate for this endpoint.

    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 4 - Token Verification
     * Checks for a matching token that hasn't expired.
     */
    const user = await findUserByResetToken(token);

    if (!user) {
      return secureErrorResponse("Invalid or expired reset token", 400, "INVALID_TOKEN");
    }

    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 5 - Admin Protection
     * Ensures admins cannot use this public flow to reset their own passwords.
     */
    if (user.role === "admin") {
      return secureErrorResponse("Admin password reset is not allowed through this method", 403, "UNAUTHORIZED");
    }

    /**
     * Update the record and invalidate the token once used.
     * The password will be automatically hashed by the User model's pre-save hook.
     */
    user.password = password;
    user.resetToken = undefined;
    user.resetTokenExpiry = undefined;
    await user.save();

    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 7 - Audit Notification
     * Send email notification indicating that the password was changed.
     */
    try {
      const { EmailService } = await import('@/lib/email');
      EmailService.sendPasswordChangeNotificationEmail(
        user.email,
        `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email,
        false
      ).catch(e => serverLogger.error("[RESET-PASSWORD] Notification failed:", e));
    } catch (emailError) {
      // fail silently on notification import errors for reliability
    }

    return secureJsonResponse({
      message: "Password has been reset successfully",
    });
  } catch (error) {
    return secureErrorResponse("Reset password failed", 500, "SERVER_ERROR", error);
  }
}
