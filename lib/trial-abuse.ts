/**
 * Anti-abuse helpers for the hosting free-trial flow.
 * Each defense is independently toggleable and returns a structured reason
 * so callers can surface a clear message back to the user.
 */

import crypto from "crypto";
import { NextRequest } from "next/server";
import TrialClaim from "@/models/TrialClaim";
import { isDisposableEmail } from "@/lib/disposable-emails";
import { RecaptchaServer } from "@/lib/recaptcha";
import { serverLogger } from "@/lib/server-logger";

const ENFORCEMENT_WINDOW_DAYS = 30;
const RECAPTCHA_MIN_SCORE = 0.5;

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
}

export interface AbuseCheckResult {
  allowed: boolean;
  reason?: string;
  code?:
    | "DISPOSABLE_EMAIL"
    | "DEVICE_THROTTLE"
    | "RECAPTCHA";
}

/**
 * Truthy-check the abuse-defense kill switch env var. When set
 * (TRIAL_ABUSE_DISABLED=true / 1 / yes), evaluateTrialAbuse
 * short-circuits to allowed AND recordTrialClaim skips writes so
 * no fresh records accumulate during the bypass window. Used for
 * operator testing while a launch-day blocker is being verified;
 * flip back to unset/false in production traffic.
 *
 * Same kill-switch pattern as RECAPTCHA_SECRET_KEY absence — see
 * `lib/recaptcha-server.ts`. Env-var-only, no admin DB toggle (the
 * 2026-06-20 captcha-reintro auto-memory `feedback_no_db_kill_switch`
 * documents why DB toggles for security defenses were avoided
 * after the step-up-reauth quirk ate two hotfix cycles).
 */
function isTrialAbuseDisabled(): boolean {
  const v = (process.env.TRIAL_ABUSE_DISABLED || "").toLowerCase().trim();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

/**
 * Runs all currently-active trial-abuse checks for the given signals.
 * Order matters: cheapest checks first.
 *
 * reCAPTCHA was re-introduced 2026-06-20. When the secret is missing
 * (env-var kill switch) verifyToken short-circuits to success so this
 * pipeline still passes cleanly.
 *
 * Whole-pipeline kill switch: TRIAL_ABUSE_DISABLED=true bypasses every
 * check. Use during operator testing or when the abuse layer itself
 * is impeding a verified-good signup (e.g. operator's own IP hit the
 * 30-day throttle while testing the launch).
 */
export async function evaluateTrialAbuse(
  signals: AbuseSignals,
  options: { recaptchaToken?: string; clientIp?: string } = {}
): Promise<AbuseCheckResult> {
  if (isTrialAbuseDisabled()) {
    serverLogger.warn(
      `[TrialAbuse] BYPASSED — TRIAL_ABUSE_DISABLED env is truthy. ` +
      `email=${signals.email ?? "none"} ipHash=${signals.ipHash?.slice(0, 8) ?? "none"}. ` +
      `Reset this env var before production traffic resumes.`
    );
    return { allowed: true };
  }

  // 1. Disposable email — instant local check.
  if (signals.email && isDisposableEmail(signals.email)) {
    return {
      allowed: false,
      code: "DISPOSABLE_EMAIL",
      reason: "Free trial is not available for temporary or disposable email addresses. Please use your real business or personal email.",
    };
  }

  // 2. reCAPTCHA verification (skipped silently when captcha is disabled
  // app-wide via the env-var kill switch — same contract used by login).
  if (options.recaptchaToken) {
    try {
      const result = await RecaptchaServer.verifyToken(options.recaptchaToken, options.clientIp);
      if (!result.success) {
        return {
          allowed: false,
          code: "RECAPTCHA",
          reason: "Security verification failed. Please refresh and try again.",
        };
      }
      const score = (result as { score?: number }).score;
      if (typeof score === "number" && score < RECAPTCHA_MIN_SCORE) {
        serverLogger.warn(
          `[TrialAbuse] reCAPTCHA score below threshold: ${score} for ip=${options.clientIp || "unknown"}`
        );
        return {
          allowed: false,
          code: "RECAPTCHA",
          reason: "Security verification failed. Please refresh and try again.",
        };
      }
    } catch (e) {
      serverLogger.warn("[TrialAbuse] reCAPTCHA verify threw, allowing:", (e as Error).message);
    }
  }

  // 3. IP throttle — REMOVED 2026-07-15 (operator decision). It blocked one
  // trial per IP per 30 days, which false-positives heavily on shared
  // networks + India mobile/CGNAT (offices, colleges, families on one public
  // IP). Abuse is still caught at the account level (one-trial-per-account in
  // the eligibility route) + the device-fingerprint throttle below +
  // disposable-email + reCAPTCHA. `ipHash` is still recorded on the claim for
  // analytics but no longer gates signup.

  // 4. Device fingerprint throttle — same browser, fresh email.
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

  // (Phone SMS OTP gate removed 2026-07-15 — feature deleted for now, may be
  // re-added later if needed.)

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
  // Skip writing claim records while the bypass is active. Otherwise
  // every test signup would accumulate a record that re-engages the
  // abuse defenses the instant the operator flips the kill switch
  // off — defeating the bypass.
  if (isTrialAbuseDisabled()) {
    serverLogger.warn(
      `[TrialAbuse] recordTrialClaim SKIPPED — TRIAL_ABUSE_DISABLED env is truthy. ` +
      `userEmail=${args.userEmail.toLowerCase()}`
    );
    return;
  }
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
