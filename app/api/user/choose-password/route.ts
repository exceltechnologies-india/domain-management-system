import { NextRequest } from "next/server";
import connectDB from "@/lib/mongodb";
import { AuthService } from "@/lib/auth";
import { getUserWithPassword } from "@/lib/services/users";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { validatedBody, z } from "@/lib/api-validation";
import { serverLogger } from "@/lib/server-logger";

/**
 * POST /api/user/choose-password — the first sign-in after a one-time password (7 Oct 2026).
 *
 * A new Customer Portal account gets a one-time password by email and `mustChangePassword`; the
 * middleware sends every dashboard/checkout page to /choose-password until this clears it. The
 * customer is already signed in with the one-time password, so it is not asked for again — this
 * route only accepts a call while the flag is set (afterwards, Account Settings changes it, and
 * asks for the current password).
 */
const schema = z.object({ newPassword: z.string().min(1).max(256) });

export async function POST(request: NextRequest) {
  const user = await AuthService.getUserFromRequest(request);
  if (!user) return secureErrorResponse("Please sign in first.", 401, "UNAUTHORIZED");

  const validation = await validatedBody(request, schema);
  if (!validation.ok) return validation.response;
  const { newPassword } = validation.data;

  try {
    await connectDB();
    const withPassword = await getUserWithPassword(user._id);
    if (!withPassword) return secureErrorResponse("Account not found.", 404, "USER_NOT_FOUND");
    if (withPassword.mustChangePassword !== true) {
      return secureErrorResponse(
        "Your password is already your own. To change it, go to Account Settings.",
        409,
        "NOT_REQUIRED",
      );
    }

    const { InputValidator } = await import("@/lib/validation");
    const strength = InputValidator.validatePasswordStrength(newPassword);
    if (!strength.isValid) return secureErrorResponse(strength.errors[0], 400, "WEAK_PASSWORD");
    if (withPassword.password && (await withPassword.comparePassword(newPassword))) {
      return secureErrorResponse("Choose a new password — not the one-time password from the email.", 400, "SAME_PASSWORD");
    }

    withPassword.password = newPassword; // hashed by the User pre-save hook, which also stamps passwordChangedAt
    withPassword.mustChangePassword = false;
    await withPassword.save();
    return secureJsonResponse({ success: true });
  } catch (error) {
    serverLogger.error("[choose-password] could not save:", error);
    return secureErrorResponse("We couldn't save your password. Please try again.", 500, "SAVE_FAILED");
  }
}
