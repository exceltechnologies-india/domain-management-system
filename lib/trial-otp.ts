/**
 * Hosting-trial phone-OTP helpers.
 *
 * Storage is Redis-backed (TTL = 10 min). The *issued* signed token returned
 * to the client after a successful verify is HMAC-signed with AUTH_SECRET so
 * the verify endpoint stays stateless once the OTP itself has been consumed.
 *
 * Wired but currently disabled — flip the admin setting
 * `hosting_trial_otp_required` to true to enforce. Until then, the endpoints
 * still respond correctly so the UI can opt-in early.
 */

import crypto from "crypto";
import { redisCache } from "@/lib/redis";

const OTP_TTL_SECONDS = 10 * 60;
const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes — enough time to finish the trial-claim flow
const TOKEN_VERSION = "v1";

function secret(): string {
  return process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || "trial-otp-fallback";
}

function normalisePhone(raw: string): string {
  return raw.replace(/\D/g, "").replace(/^91/, ""); // drop the +91 country code if included
}

function otpKey(phone: string): string {
  return `trial-otp:${normalisePhone(phone)}`;
}

export function generateOtp(): string {
  // 6 digits, leading zeros preserved
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export async function storeOtp(phone: string, code: string): Promise<void> {
  await redisCache.set(otpKey(phone), { code, attempts: 0 }, OTP_TTL_SECONDS);
}

export async function consumeOtp(
  phone: string,
  code: string
): Promise<{ ok: boolean; reason?: string }> {
  const entry = await redisCache.get<{ code: string; attempts: number }>(otpKey(phone));
  if (!entry) {
    return { ok: false, reason: "OTP expired or never requested. Please request a new code." };
  }
  if (entry.attempts >= 5) {
    await redisCache.del(otpKey(phone));
    return { ok: false, reason: "Too many incorrect attempts. Please request a new code." };
  }
  if (entry.code !== code) {
    await redisCache.set(
      otpKey(phone),
      { code: entry.code, attempts: entry.attempts + 1 },
      OTP_TTL_SECONDS
    );
    return { ok: false, reason: "Incorrect code. Please try again." };
  }
  await redisCache.del(otpKey(phone));
  return { ok: true };
}

/** Signed proof-of-verification. Returned to the client; passed back on
 * trial claim. Stateless — verified by HMAC, scoped to phone + expiry. */
export function signOtpToken(phone: string): string {
  const payload = {
    v: TOKEN_VERSION,
    p: normalisePhone(phone),
    e: Date.now() + TOKEN_TTL_MS,
  };
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(b64).digest("base64url");
  return `${b64}.${sig}`;
}

export function verifyOtpToken(
  token: string,
  expectedPhone?: string
): { valid: boolean; phone?: string; reason?: string } {
  if (!token || typeof token !== "string" || !token.includes(".")) {
    return { valid: false, reason: "Malformed token" };
  }
  const [b64, sig] = token.split(".");
  const expectedSig = crypto.createHmac("sha256", secret()).update(b64).digest("base64url");
  if (sig !== expectedSig) {
    return { valid: false, reason: "Invalid signature" };
  }
  try {
    const payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
    if (payload.v !== TOKEN_VERSION) {
      return { valid: false, reason: "Unsupported token version" };
    }
    if (Date.now() > payload.e) {
      return { valid: false, reason: "Token expired" };
    }
    if (expectedPhone && normalisePhone(expectedPhone) !== payload.p) {
      return { valid: false, reason: "Token does not match phone" };
    }
    return { valid: true, phone: payload.p };
  } catch {
    return { valid: false, reason: "Malformed token" };
  }
}
