/**
 * Phase 1 integration: Customer Panel -> Support Panel (DSP) single sign-on.
 *
 * Mints a short-lived signed handoff token proving "this browser is an
 * already-authenticated Customer Panel user" so DSP can log them in
 * automatically instead of showing its own login screen. Signed with
 * SSO_SHARED_SECRET — deliberately separate from NEXTAUTH_SECRET/JWT_SECRET
 * so a leak of one doesn't compromise the other.
 */

import jwt from "jsonwebtoken";
import crypto from "crypto";

const SSO_TOKEN_TTL_SECONDS = 60;

interface SupportSsoUser {
  id: string;
  email: string;
  name: string;
}

function getSharedSecret(): string {
  const secret = process.env.SSO_SHARED_SECRET;
  if (!secret) {
    throw new Error("SSO_SHARED_SECRET is not configured");
  }
  return secret;
}

function getDspSupportUrl(): string {
  const baseUrl = process.env.DSP_SUPPORT_URL;
  if (!baseUrl) {
    throw new Error("DSP_SUPPORT_URL is not configured");
  }
  return baseUrl.replace(/\/$/, "");
}

export function mintSupportSsoToken(user: SupportSsoUser): string {
  // jti lets DSP enforce single-use on the handoff token (replay protection).
  const jti = crypto.randomBytes(16).toString("hex");
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name, purpose: "dsp-sso", jti },
    getSharedSecret(),
    { algorithm: "HS256", expiresIn: SSO_TOKEN_TTL_SECONDS }
  );
}

export function buildSupportSsoRedirectUrl(user: SupportSsoUser): string {
  const token = mintSupportSsoToken(user);
  return `${getDspSupportUrl()}/sso?token=${encodeURIComponent(token)}`;
}
