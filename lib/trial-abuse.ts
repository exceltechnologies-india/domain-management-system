/**
 * Anti-abuse helpers for the hosting free-trial flow.
 * Each defense is independently toggleable and returns a structured reason
 * so callers can surface a clear message back to the user.
 */

import crypto from "crypto";
import { NextRequest } from "next/server";
import TrialClaim from "@/models/TrialClaim";
import { getSettingValue } from "@/lib/services/settings";
import { isDisposableEmail } from "@/lib/disposable-emails";
import { serverLogger } from "@/lib/server-logger";
import { verifyOtpToken } from "@/lib/trial-otp";

const ENFORCEMENT_WINDOW_DAYS = 30;

function ipHashSecret(): string {
  return process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || "trial-abuse-fallback";
}

/** Pulls the client IP from common proxy headers. Returns "unknown" if absent. */
export function getClientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

/**
 * Stable hash of the client IP. We never persist the raw IP — keyed hash means
 * the model can be queried by an attacker with DB access without revealing
 * which users came from which IP.
 */
export function hashIp(ip: string): string {
  if (!ip || ip === "unknown") return "";
  return crypto.createHmac("sha256", ipHashSecret()).update(ip).digest("hex");
}

export interface AbuseSignals {
  email?: string;
  ipHash?: string;
  deviceFingerprint?: string;
  /** User's phone number; required when the OTP gate is active. */
  phone?: string;
  /** Signed token returned by /trial-otp/verify; required when OTP is active. */
  otpToken?: string;
}

export interface AbuseCheckResult {
  allowed: boolean;
  reason?: string;
  code?:
    | "DISPOSABLE_EMAIL"
    | "IP_THROTTLE"
    | "DEVICE_THROTTLE"
    | "OTP_REQUIRED";
}

/**
 * Runs all currently-active trial-abuse checks for the given signals.
 * Order matters: cheapest checks first.
 *
 * reCAPTCHA was removed from the trial-abuse pipeline on 2026-06-17 (full
 * rip ahead of a fresh re-install). Disposable-email + IP throttle + device
 * fingerprint + optional phone OTP still gate trial claims.
 */
export async function evaluateTrialAbuse(
  signals: AbuseSignals,
  // Kept for signature stability; reCAPTCHA option is currently ignored.
  _options: { clientIp?: string } = {}
): Promise<AbuseCheckResult> {
  // 1. Disposable email — instant local check.
  if (signals.email && isDisposableEmail(signals.email)) {
    return {
      allowed: false,
      code: "DISPOSABLE_EMAIL",
      reason: "Free trial is not available for temporary or disposable email addresses. Please use your real business or personal email.",
    };
  }

  // 2. IP throttle — has this IP claimed a trial within the window?
  if (signals.ipHash) {
    const since = new Date(Date.now() - ENFORCEMENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const ipClaim = await TrialClaim.exists({
      ipHash: signals.ipHash,
      createdAt: { $gte: since },
    });
    if (ipClaim) {
      return {
        allowed: false,
        code: "IP_THROTTLE",
        reason: "A free trial has already been claimed from this network in the last 30 days. Log into your existing account or contact support if this seems wrong.",
      };
    }
  }

  // 3. Device fingerprint throttle — same browser, fresh email.
  if (signals.deviceFingerprint) {
    const since = new Date(Date.now() - ENFORCEMENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const deviceClaim = await TrialClaim.exists({
      deviceFingerprint: signals.deviceFingerprint,
      createdAt: { $gte: since },
    });
    if (deviceClaim) {
      return {
        allowed: false,
        code: "DEVICE_THROTTLE",
        reason: "This device has already claimed a free trial. Log into your previous account to continue.",
      };
    }
  }

  // 4. Phone OTP — only enforced when admin has flipped the toggle.
  if (await isTrialOtpRequired()) {
    if (!signals.otpToken) {
      return {
        allowed: false,
        code: "OTP_REQUIRED",
        reason: "Please verify your phone number before claiming the free trial.",
      };
    }
    const tokenCheck = verifyOtpToken(signals.otpToken, signals.phone);
    if (!tokenCheck.valid) {
      return {
        allowed: false,
        code: "OTP_REQUIRED",
        reason: tokenCheck.reason || "Phone verification failed. Please re-verify.",
      };
    }
  }

  return { allowed: true };
}

/**
 * Records a successful trial claim so subsequent attempts from the same
 * IP / device / email show up in the abuse check.
 */
export async function recordTrialClaim(args: {
  userId: string;
  userEmail: string;
  ipHash?: string;
  deviceFingerprint?: string;
  planId?: string;
}): Promise<void> {
  try {
    await TrialClaim.create({
      userId: args.userId,
      userEmail: args.userEmail.toLowerCase(),
      ipHash: args.ipHash || undefined,
      deviceFingerprint: args.deviceFingerprint || undefined,
      planId: args.planId,
    });
  } catch (err) {
    // E11000 = duplicate key on the partial unique (ipHash, deviceFingerprint)
    // index. Race fence — a prior insert from the same IP+device won; this
    // attempt is a coordinated double-claim. Log loudly so abuse patterns
    // surface in metrics, but don't throw — the user's already paid the
    // ₹1 trial fee and got the hosting, so a failed-to-record is harmless
    // (the prior claim row already blocks future trials from this signal).
    const isDuplicate =
      err instanceof Error &&
      ("code" in err ? (err as { code?: number }).code === 11000 : false);
    if (isDuplicate) {
      serverLogger.warn(
        `[TrialAbuse] Duplicate trial claim blocked by unique index (race) — ` +
        `userEmail=${args.userEmail.toLowerCase()} ipHash=${args.ipHash?.slice(0, 8) ?? "none"}`
      );
      return;
    }
    // Other errors are still best-effort.
    serverLogger.error("[TrialAbuse] Failed to record trial claim:", err);
  }
}

/**
 * Phone-OTP gate. Wired but disabled by default — flip the admin setting
 * `hosting_trial_otp_required` to true when you're ready to enforce.
 */
export async function isTrialOtpRequired(): Promise<boolean> {
  const v = await getSettingValue("hosting_trial_otp_required");
  return v === true || v === "true";
}
