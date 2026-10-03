import { NextRequest } from "next/server";
import crypto from "crypto";
import { getUserByEmail, getUserWithPassword } from "@/lib/services/users";
import { AuthService } from "@/lib/auth";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { sendEmail, SUPPORT_EMAIL } from "@/lib/email/transporter";
import { brandName, firstName, plainEmailHtml } from "@/lib/email/plain";
import { validatedBody, z } from "@/lib/api-validation";
import { Schemas } from "@/lib/validation";

const changeEmailSchema = z.object({
  newEmail: Schemas.email,
  currentPassword: z.string().min(1, "currentPassword is required").max(256),
});

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

    const validation = await validatedBody(request, changeEmailSchema);
    if (!validation.ok) return validation.response;
    // Schemas.email already lowercases + trims + format-checks.
    const { newEmail: normalizedEmail, currentPassword } = validation.data;

    if (normalizedEmail === user.email.toLowerCase()) {
      return secureErrorResponse(
        "New email must be different from current email",
        400,
        "SAME_EMAIL"
      );
    }

    // Re-fetch with password field (select: false by default)
    const userWithPassword = await getUserWithPassword(user._id);
    if (!userWithPassword?.password) {
      return secureErrorResponse("Cannot verify identity", 400, "NO_PASSWORD");
    }

    const passwordValid = await userWithPassword.comparePassword(currentPassword);
    if (!passwordValid) {
      return secureErrorResponse("Incorrect current password", 401, "INVALID_PASSWORD");
    }

    // Check new email is not already registered
    const existing = await getUserByEmail(normalizedEmail);
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
    const verifyUrl = `${appUrl}/api/v1/user/settings/verify-email-change?token=${rawToken}`;
    // "Hi <first name>," — firstName() falls back to "there" when the account has no name.
    const userName = `${userWithPassword.firstName || ""} ${userWithPassword.lastName || ""}`.trim();

    // Both in the ResellerOS plain-text pattern (lib/email/plain.ts; owner, 3 Oct 2026).
    const signOff = `Questions? Reply to this email or write to ${SUPPORT_EMAIL}.\n\n— ${brandName()}`;

    // 1. Verification link → new address
    const verifyText =
`Hi ${firstName(userName)},

You asked to change the email address on your ${brandName()} account to this one. Confirm it here — the link expires in 1 hour:
  ${verifyUrl}

If you didn't ask for this change, you can safely ignore this email. Your current address stays active.

${signOff}`;
    await sendEmail({
      to: normalizedEmail,
      subject: "Confirm your new email address",
      text: verifyText,
      html: plainEmailHtml(verifyText),
    });

    // 2. Security alert → current (old) address
    const alertText =
`Hi ${firstName(userName)},

Someone asked to change the email address on your ${brandName()} account to ${normalizedEmail}.

If this was you, open your new inbox and click the confirmation link we sent there.

If it was NOT you, your account may be at risk. Reset your password straight away and contact us:
  ${appUrl}/reset-password

${signOff}`;
    await sendEmail({
      to: userWithPassword.email,
      subject: "Security alert: email change requested",
      text: alertText,
      html: plainEmailHtml(alertText),
    });

    serverLogger.info(`[EMAIL-CHANGE] Verification email sent for user ...${String(userWithPassword._id).slice(-6)}`);

    return secureJsonResponse({
      message: "If that address is available, a verification link has been sent to it.",
    });
  } catch (error: unknown) {
    serverLogger.error("[EMAIL-CHANGE] Error:", error instanceof Error ? error.message : error);
    return secureErrorResponse("Failed to initiate email change", 500, "INTERNAL_ERROR");
  }
}
