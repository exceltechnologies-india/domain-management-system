import { NextRequest } from "next/server";
import { rateLimiters, rateLimitResponse } from "@/lib/rate-limit";
import { consumeOtp, signOtpToken } from "@/lib/trial-otp";
import { serverLogger } from "@/lib/server-logger";
import {
  secureJsonResponse,
  secureErrorResponse,
} from "@/lib/api-response-wrapper";
import { validatedBody, z } from "@/lib/api-validation";

const verifyOtpSchema = z.object({
  phone: z.string().trim().min(1).max(20),
  code: z.string().regex(/^\d{6}$/, "Invalid code format"),
});

export const dynamic = "force-dynamic";

/**
 * POST /api/user/hosting/trial-otp/verify
 *
 * Body: { phone: string, code: string }
 * Response on success: { success: true, token: string }
 *
 * The signed `token` is passed to the trial-claim flow so the eligibility +
 * create-order endpoints can verify OTP completion without re-querying Redis.
 */
export async function POST(request: NextRequest) {
  try {
    const rl = await rateLimiters.trialOtpVerify.isAllowed(request);
    if (!rl.allowed) {
      return rateLimitResponse(rl, {
        limit: 10,
        message: "Too many attempts. Please wait a few minutes.",
      });
    }

    const validation = await validatedBody(request, verifyOtpSchema);
    if (!validation.ok) return validation.response;
    const { phone, code } = validation.data;

    const digits = phone.replace(/\D/g, "").replace(/^91/, "");
    if (digits.length !== 10) {
      return secureErrorResponse(
        "Invalid phone number",
        400,
        "VALIDATION_ERROR"
      );
    }

    const result = await consumeOtp(digits, code);
    if (!result.ok) {
      return secureErrorResponse(
        result.reason || "Verification failed",
        400,
        "INVALID_OTP"
      );
    }

    const token = signOtpToken(digits);
    return secureJsonResponse({
      success: true,
      message: "Phone verified. You can now claim your free trial.",
      token,
    });
  } catch (err: unknown) {
    serverLogger.error("[TrialOtp:verify] error:", err);
    return secureErrorResponse(
      "Internal server error",
      500,
      "SERVER_ERROR",
      err
    );
  }
}
