/**
 * NextAuth configuration — backwards-compatible barrel.
 *
 * The implementation lives in focused submodules under `./auth-config/`.
 * This file preserves the historic `authOptions` export shape so existing
 * call sites do not have to change.
 *
 * Submodules:
 * - ./auth-config/helpers    types, extractSocialName, SOCIAL_PROVIDERS, useSecureCookies
 * - ./auth-config/providers  Google, Facebook, GitHub, Credentials providers
 * - ./auth-config/callbacks  signIn, jwt, session callbacks
 * - ./auth-config/cookies    explicit cookie hardening
 */

import { AUTH_SECRET } from "@/lib/auth-secret";
import { NextAuthOptions } from "next-auth";
import { serverLogger } from "@/lib/server-logger";

import { providers } from "./auth-config/providers";
import { callbacks } from "./auth-config/callbacks";
import { cookies } from "./auth-config/cookies";

export const authOptions: NextAuthOptions = {
  providers,
  callbacks,
  pages: {
    signIn: "/login",
    error: "/login",
  },
  debug: process.env.NODE_ENV === "development", // Enable debug only in development
  logger: {
    error(code, ...message) {
      // Log ALL errors with full details for debugging
      serverLogger.error("NextAuth Error:", code, JSON.stringify(message));
    },
    warn(code) {
      serverLogger.warn("NextAuth Warning:", code);
    },
    debug(code, metadata) {
      serverLogger.log(
        "NextAuth Debug:",
        code,
        metadata ? JSON.stringify(metadata) : ""
      );
    },
  },
  // Explicit cookie flags — hardens what NextAuth already does implicitly and makes
  // the security posture visible. __Secure-/__Host- prefixes require Secure + HTTPS.
  cookies,
  session: {
    strategy: "jwt",
    maxAge: 30 * 60, // 30 minutes for all users; admins get stricter enforcement via session-activity.ts
  },
  secret: AUTH_SECRET,
};
