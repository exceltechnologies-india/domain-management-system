import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import {
  findUserByEmailExcluding,
  findUserByPendingEmailToken,
} from "@/lib/services/users";
import { serverLogger } from "@/lib/server-logger";
import { sendEmail } from "@/lib/email/transporter";

export const dynamic = "force-dynamic";

/**
 * GET /api/user/settings/verify-email-change?token=<raw-token>
 *
 * Completes an email address change:
 *   1. Resolves the token to a user record (SHA-256 hash comparison)
 *   2. Checks expiry
 *   3. Confirms the new address is still available
 *   4. Swaps user.email ↔ pendingEmail, clears token fields
 *   5. Invalidates all active sessions (forces re-login with new address)
 *   6. Sends a confirmation to the old address
 *   7. Redirects to /login with a success flag
 */
export async function GET(request: NextRequest) {
  const appUrl = process.env.NEXTAUTH_URL ?? "https://app.anutech.in";

  try {
    const { searchParams } = new URL(request.url);
    const rawToken = searchParams.get("token");

    if (!rawToken || typeof rawToken !== "string" || rawToken.length !== 64) {
      return NextResponse.redirect(
        new URL("/login?email_change=invalid", appUrl)
      );
    }

    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    const user = await findUserByPendingEmailToken(tokenHash);

    if (!user) {
      return NextResponse.redirect(
        new URL("/login?email_change=invalid", appUrl)
      );
    }

    const newEmail = user.pendingEmail!;

    // Re-check availability — another account may have registered this address
    // during the TTL window
    const conflict = await findUserByEmailExcluding(newEmail, user._id);
    if (conflict) {
      user.pendingEmail = undefined;
      user.pendingEmailToken = undefined;
      user.pendingEmailExpiry = undefined;
      await user.save();
      return NextResponse.redirect(
        new URL("/login?email_change=taken", appUrl)
      );
    }

    const oldEmail = user.email;
    const userName = `${user.firstName || ""} ${user.lastName || ""}`.trim() || oldEmail;

    // Apply the change
    user.email = newEmail;
    user.pendingEmail = undefined;
    user.pendingEmailToken = undefined;
    user.pendingEmailExpiry = undefined;
    // Invalidate all sessions — user must re-login with new address
    user.sessionInvalidatedAt = new Date();
    await user.save();

    serverLogger.info(`[EMAIL-CHANGE] Email updated for user ...${String(user._id).slice(-6)} (old domain: ...${oldEmail.split("@")[1]})`);

    // Notify old address that the change completed
    await sendEmail({
      to: oldEmail,
      subject: "Your email address has been changed – Anutech Digital",
      html: `
        <p>Hi ${userName},</p>
        <p>The email address on your Anutech Digital account has been successfully changed to <strong>${newEmail}</strong>.</p>
        <p>You have been signed out of all devices. Please sign in again using your new address.</p>
        <p>If you did <strong>not</strong> make this change, please <a href="${appUrl}/reset-password">reset your password immediately</a> and contact support.</p>
        <p>– Anutech Digital Team</p>
      `,
    }).catch((err) => {
      serverLogger.error("[EMAIL-CHANGE] Failed to send old-address notification:", err.message);
    });

    return NextResponse.redirect(
      new URL("/login?email_change=success", appUrl)
    );
  } catch (error: any) {
    serverLogger.error("[EMAIL-CHANGE] Verify error:", error.message || error);
    return NextResponse.redirect(
      new URL("/login?email_change=error", appUrl)
    );
  }
}
