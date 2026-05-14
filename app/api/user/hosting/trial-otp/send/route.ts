import { NextRequest } from "next/server";
import { AuthService } from "@/lib/auth";
import { rateLimiters } from "@/lib/rate-limit";
import { sendSms } from "@/lib/sms";
import { generateOtp, storeOtp } from "@/lib/trial-otp";
import { serverLogger } from "@/lib/server-logger";
import {
  secureJsonResponse,
  secureErrorResponse,
} from "@/lib/api-response-wrapper";

export const dynamic = "force-dynamic";

/**
 * POST /api/user/hosting/trial-otp/send
 *
 * Sends a 6-digit OTP to the user's phone (or the phone in the body for the
 * not-yet-built guest-trial path). Authentication is optional — when present,
 * we trust the User record's phone if no body phone is supplied.
 *
 * Wired but not enforced until the admin flips `hosting_trial_otp_required`.
 */
export async function POST(request: NextRequest) {
  try {
    const rl = await rateLimiters.trialOtpSend.isAllowed(request);
    if (!rl.allowed) {
      return secureErrorResponse(
        "Too many OTP requests. Please wait a few minutes and try again.",
        429,
        "RATE_LIMITED"
      );
    }

    const body = (await request.json().catch(() => ({}))) as { phone?: string };
    let phone = body.phone?.toString().trim();

    if (!phone) {
      const user = await AuthService.getUserFromRequest(request);
      if (user?.phone) phone = user.phone;
    }
    if (!phone) {
      return secureErrorResponse(
        "Phone number is required",
        400,
        "VALIDATION_ERROR"
      );
    }

    const digits = phone.replace(/\D/g, "").replace(/^91/, "");
    if (digits.length !== 10) {
      return secureErrorResponse(
        "Please enter a valid 10-digit Indian mobile number.",
        400,
        "VALIDATION_ERROR"
      );
    }

    const code = generateOtp();
    await storeOtp(digits, code);

    const sms = await sendSms({
      to: digits,
      template: "trial_otp",
      variables: { otp: code, var1: code },
    });

    if (!sms.success) {
      serverLogger.error(
        `[TrialOtp:send] SMS provider ${sms.provider} failed: ${sms.error}`
      );
      return secureErrorResponse(
        "Could not send the OTP right now. Please try again in a moment.",
        502,
        "SMS_PROVIDER_ERROR"
      );
    }

    return secureJsonResponse({
      success: true,
      message: "OTP sent. Please check your phone.",
      provider: sms.provider,
    });
  } catch (err: any) {
    serverLogger.error("[TrialOtp:send] error:", err);
    return secureErrorResponse(
      "Internal server error",
      500,
      "SERVER_ERROR",
      err
    );
  }
}
