/**
 * NextAuth providers: Google, Facebook, GitHub, Credentials.
 */

import GoogleProvider from "next-auth/providers/google";
import FacebookProvider from "next-auth/providers/facebook";
import GithubProvider from "next-auth/providers/github";
import CredentialsProvider from "next-auth/providers/credentials";
import connectDB from "@/lib/mongodb";
import {
  consumeUserBackupCode,
  getUserByEmailForLogin,
  getUserWithTOTPSecretsForLogin,
} from "@/lib/services/users";
import { serverLogger } from "@/lib/server-logger";
import { updateLastActivity } from "@/lib/session-activity";
import { verifyTotpCode, verifyBackupCode } from "@/lib/totp";
import { rateLimiters } from "@/lib/rate-limit";

export const providers = [
  GoogleProvider({
    clientId: process.env.GOOGLE_CLIENT_ID!.trim(),
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!.trim(),
    authorization: {
      params: {
        // Request only basic scopes (sensitive scopes require Google verification)
        scope: "openid email profile",
        prompt: "consent",
        access_type: "offline",
        response_type: "code",
      },
    },
    // Request additional profile fields
    profile(profile) {
      return {
        id: profile.sub,
        name: profile.name,
        email: profile.email,
        image: profile.picture,
        role: "user" as const,
        // Additional fields from Google profile
        given_name: profile.given_name,
        family_name: profile.family_name,
        locale: profile.locale,
      };
    },
  }),

  ...(process.env.FACEBOOK_CLIENT_ID && process.env.FACEBOOK_CLIENT_SECRET
    ? [
        FacebookProvider({
          clientId: process.env.FACEBOOK_CLIENT_ID,
          clientSecret: process.env.FACEBOOK_CLIENT_SECRET,
        }),
      ]
    : []),

  ...(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
    ? [
        GithubProvider({
          clientId: process.env.GITHUB_CLIENT_ID,
          clientSecret: process.env.GITHUB_CLIENT_SECRET,
        }),
      ]
    : []),

  CredentialsProvider({
    name: "credentials",
    credentials: {
      email: { label: "Email", type: "email" },
      password: { label: "Password", type: "password" },
      totpCode: { label: "Authenticator Code", type: "text" },
    },
    async authorize(credentials, req) {
      try {
        if (!credentials?.email || !credentials?.password) {
          throw new Error("Email and password are required");
        }

        // Rate limiting — keyed by email + IP so both per-user and per-IP attacks are caught
        // NextAuth passes the raw incoming request differently across runtimes
        // (Headers-like object on Node, plain object on Edge in some configs).
        // Narrow once at the access site.
        const rawHeaders = (req as { headers?: unknown } | undefined)?.headers;
        const readHeader = (name: string): string | undefined => {
          if (!rawHeaders) return undefined;
          if (typeof (rawHeaders as Headers).get === "function") {
            return (rawHeaders as Headers).get(name) ?? undefined;
          }
          return (rawHeaders as Record<string, string | undefined>)[name];
        };
        const ip =
          readHeader("x-forwarded-for") ||
          readHeader("x-real-ip") ||
          "unknown";
        const rateLimitKey = `login:${credentials.email.toLowerCase()}:${ip}`;
        const rateLimit = await rateLimiters.login.checkKey(rateLimitKey);
        if (!rateLimit.allowed) {
          serverLogger.warn(`[AUTH] ❌ Rate limit exceeded for ${credentials.email} from ${ip}`);
          throw new Error("TooManyRequests");
        }

        serverLogger.log(
          "[AUTH] 🔑 Password provided:",
          !!credentials.password
        );

        // reCAPTCHA was removed on 2026-06-17 (full rip ahead of a fresh
        // re-install). Rate limiting (above) + per-IP login throttling still
        // gate brute-force; CSRF + same-origin checks in middleware still
        // gate cross-site abuse. Login no longer requires a captcha token.

        // Race connectDB against timeout
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Connection timed out')), 10000)
        );

        await Promise.race([connectDB(), timeoutPromise]);

        const user = await getUserByEmailForLogin(credentials.email, { maxTimeMS: 5000 });
        if (!user) {
          throw new Error("Invalid email or password");
        }

        // Check if user is activated
        if (!user.isActivated) {
          serverLogger.error(
            "[AUTH] ❌ User not activated:",
            credentials.email
          );
          throw new Error("AccountNotActivated");
        }

        // Check if user is active
        if (!user.isActive) {
          serverLogger.error(
            "[AUTH] ❌ User deactivated:",
            credentials.email
          );
          throw new Error("AccountDeactivated");
        }

        // Verify password
        const isPasswordValid = await user.comparePassword(
          credentials.password
        );
        if (!isPasswordValid) {
          serverLogger.error(
            "[AUTH] ❌ Invalid password for:",
            credentials.email
          );
          throw new Error("Invalid email or password");
        }

        // 2FA check — required for any account that has TOTP enabled
        if (user.totpEnabled) {
          if (!credentials.totpCode) {
            throw new Error("TotpRequired");
          }

          const userWithSecrets = await getUserWithTOTPSecretsForLogin(user._id);

          const isValidTotp =
            userWithSecrets?.totpSecret &&
            verifyTotpCode(userWithSecrets.totpSecret, credentials.totpCode);

          if (!isValidTotp) {
            // Try backup codes (one-time use)
            let matchedBackupHash: string | null = null;
            if (userWithSecrets?.totpBackupCodes?.length) {
              for (const hash of userWithSecrets.totpBackupCodes) {
                if (await verifyBackupCode(credentials.totpCode, hash)) {
                  matchedBackupHash = hash;
                  break;
                }
              }
            }
            if (!matchedBackupHash) {
              throw new Error("InvalidTotpCode");
            }
            // Consume the backup code so it cannot be reused
            await consumeUserBackupCode(user._id, matchedBackupHash);
            serverLogger.warn(
              `[AUTH] ${user.email} signed in using a 2FA backup code`
            );
          }
        }

        // Update last activity on successful login
        await updateLastActivity(String(user._id ?? user.id ?? ""));

        const returnData = {
          id: user._id?.toString() || "",
          email: user.email,
          name: `${user.firstName} ${user.lastName}`,
          role: user.role,
        };

        return returnData;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        serverLogger.error("[AUTH] Authorize Error:", message);
        throw error;
      }
    },
  }),
];
