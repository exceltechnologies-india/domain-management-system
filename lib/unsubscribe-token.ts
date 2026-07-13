import crypto from "crypto";

/**
 * Signed, stateless unsubscribe tokens.
 *
 * An unsubscribe link must identify the recipient WITHOUT a login (they're
 * clicking from an email), so the token carries the email address plus an
 * HMAC signature. This makes the token unforgeable and non-enumerable — you
 * can't opt someone else out by guessing a URL.
 *
 * Format: base64url(email) + "." + base64url(HMAC_SHA256(email))
 */

function secret(): string {
  const s =
    process.env.NEXTAUTH_SECRET ||
    process.env.AUTH_SECRET ||
    process.env.JWT_SECRET;
  if (!s) {
    throw new Error("Unsubscribe token secret missing (NEXTAUTH_SECRET/AUTH_SECRET/JWT_SECRET)");
  }
  return s;
}

function sign(email: string): string {
  return crypto
    .createHmac("sha256", secret())
    .update(`unsubscribe:${email.toLowerCase()}`)
    .digest("base64url");
}

export function makeUnsubscribeToken(email: string): string {
  const payload = Buffer.from(email.toLowerCase(), "utf8").toString("base64url");
  return `${payload}.${sign(email)}`;
}

/**
 * Verify a token and return the email it was issued for, or null if the
 * token is malformed or the signature doesn't match. Uses a constant-time
 * comparison to avoid signature-timing leaks.
 */
export function verifyUnsubscribeToken(token: string): string | null {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  let email: string;
  try {
    email = Buffer.from(payload, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!email) return null;
  const expected = sign(email);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return email.toLowerCase();
}

/** Build the absolute unsubscribe URL for an email address. */
export function unsubscribeUrl(email: string): string {
  const base =
    process.env.APP_URL ||
    process.env.NEXTAUTH_URL ||
    "https://app.anutech.in";
  return `${base.replace(/\/$/, "")}/api/notifications/unsubscribe?token=${encodeURIComponent(
    makeUnsubscribeToken(email)
  )}`;
}
