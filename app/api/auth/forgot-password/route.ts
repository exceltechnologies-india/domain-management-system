import { NextRequest, NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import User from "@/models/User";
import { EmailService } from "@/lib/email";
import { RecaptchaServer } from "@/lib/recaptcha";
import { rateLimiters } from "@/lib/rate-limit";
import { Schemas } from "@/lib/validation";
import { SecurityValidator } from "@/lib/security";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import crypto from "crypto";

// Force dynamic rendering - required for API routes
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 1 - CSRF Protection
     * Verifies that the request originated from our authorized domain.
     */
    const csrfCheck = SecurityValidator.validateCSRF(request);
    if (!csrfCheck.isValid) {
      return secureErrorResponse(csrfCheck.error || "CSRF Validation Failed", 403, "CSRF_ERROR");
    }

    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 2 - Rate Limiting
     * Prevents automated password reset requests which could be used for spam or enumeration.
     */
    const rateLimit = await rateLimiters.passwordReset.isAllowed(request);
    if (!rateLimit.allowed) {
      return secureErrorResponse(
        "Too many password reset attempts. Please try again later.",
        429,
        "RATE_LIMIT_EXCEEDED"
      );
    }

    const body = await request.json();
    
    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 3 - Schema Validation
     * Strictly validates the email format and the presence of a security token.
     */
    const result = Schemas.forgotPassword.safeParse(body);
    if (!result.success) {
      return secureErrorResponse("Invalid request data", 400, "VALIDATION_ERROR", result.error.format());
    }

    const { email, recaptchaToken } = result.data;

    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 4 - Human Verification
     * Google reCAPTCHA verification.
     */
    const clientIP = request.headers.get("x-forwarded-for")?.split(",")[0] ||
                     request.headers.get("x-real-ip") ||
                     "unknown";
    const recaptchaResult = await RecaptchaServer.verifyToken(
      recaptchaToken,
      clientIP
    );

    if (!recaptchaResult.success) {
      return secureErrorResponse("Security verification failed. Please try again.", 403, "SECURITY_CHECK_FAILED");
    }

    await connectDB();

    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 5 - Email Enumeration Defense
     * In production, we return the same success-like message whether the account exists or not.
     * This prevents attackers from learning which emails are registered in our system.
     */
    const user = await User.findOne({ email });
    if (!user) {
      return secureJsonResponse({
        message: "If an account with that email exists, we've sent a password reset link.",
      });
    }

    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 6 - Privilege Safety
     * Admin accounts cannot be reset through this public community flow.
     * Admins must follow a more secure internal process.
     */
    if (user.role === "admin") {
      return secureJsonResponse({
        message: "If an account with that email exists, we've sent a password reset link.",
      });
    }

    // Generate a secure single-use reset token
    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetTokenExpiry = new Date(Date.now() + 3600000); // 1 hour validity

    user.resetToken = resetToken;
    user.resetTokenExpiry = resetTokenExpiry;
    await user.save();

    /**
     * 🛡️ DEFENSE-IN-DEPTH: Security Layer 7 - Secure Communication
     * Send password reset email with the secure token.
     *
     * For guest-converted accounts (no password chosen yet), frame the email
     * as a first-time setup so the copy + button + subject all read
     * "Set Password" instead of "Reset Password".
     */
    const isFirstTimeSetup = user.isGuest === true;
    const emailSent = await EmailService.sendPasswordResetEmail(
      user.email,
      `${user.firstName} ${user.lastName}`,
      resetToken,
      isFirstTimeSetup
    );

    if (!emailSent) {
      return secureErrorResponse("Failed to send reset email", 500, "EMAIL_ERROR");
    }

    return secureJsonResponse({
      message: "If an account with that email exists, we've sent a password reset link.",
    });
  } catch (error) {
    return secureErrorResponse("Password reset request failed", 500, "SERVER_ERROR", error);
  }
}
