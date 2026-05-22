import { getUserById } from "@/lib/services/users";
import { AUTH_SECRET } from "@/lib/auth-secret";
import { serverLogger } from "@/lib/server-logger";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { NextRequest } from "next/server";
import connectDB from "./mongodb";
import type { IUser } from "@/models/User";
import { getServerSession } from "next-auth/next";
import { getToken } from "next-auth/jwt";
import { authOptions } from "@/lib/auth-config";

const JWT_SECRET = AUTH_SECRET;

export interface JWTPayload {
  userId: string;
  email: string;
  role: string;
  jti?: string; // JWT ID
  iat?: number; // Issued at
}

/**
 * Authentication Service Core
 * 
 * Central utility class for managing JSON Web Tokens (JWT) across the application.
 * It provides stateless authentication checks by generating, verifying, and decoding
 * tokens, while falling back to NextAuth sessions when appropriate.
 */
export class AuthService {
  /**
   * Generate JWT token with enhanced security
   */
  static generateToken(
    payload: JWTPayload,
    rememberMe: boolean = false
  ): string {
    // Different expiration times based on remember me
    const expiresIn = rememberMe ? "30d" : "24h";

    // Add additional security claims to payload
    const enhancedPayload = {
      ...payload,
      // Unique token ID. Date.now() alone collides when two tokens are minted
      // in the same millisecond (CI used to flake on this; same-ms minting
      // also breaks any future JTI-based revocation list / replay detection).
      // Add a crypto-random suffix so JTIs are unique regardless of timing.
      jti: `${payload.userId}_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`,
      iat: Math.floor(Date.now() / 1000), // Issued at
    };

    return jwt.sign(enhancedPayload, JWT_SECRET, {
      expiresIn,
      issuer: "excel-technologies",
      audience: "domain-management-system",
      algorithm: "HS256",
    });
  }

  /**
   * Verifies an incoming JWT token with strict structural integrity checks:
   * algorithm pinned to HS256, issuer + audience matched, expiry + 30-day
   * max-age enforced. Returns the decoded payload on success or null on any
   * failure. Callers MUST still resolve `payload.userId` against the DB —
   * `role` from the payload is informational only.
   */
  static verifyToken(token: string): JWTPayload | null {
    try {
      const decoded = jwt.verify(token, JWT_SECRET, {
        issuer: "excel-technologies",
        audience: "domain-management-system",
        algorithms: ["HS256"],
      }) as JWTPayload & { iat?: number };

      if (!decoded.userId || !decoded.email || !decoded.role) {
        return null;
      }

      const tokenAge = Date.now() / 1000 - (decoded.iat ?? 0);
      const maxAge = 30 * 24 * 60 * 60; // 30 days in seconds
      if (tokenAge > maxAge) {
        return null;
      }

      return decoded as JWTPayload;
    } catch {
      return null;
    }
  }

  /**
   * Extracts and authenticates a user strictly based on a NextRequest instance.
   * 
   * Operation flow:
   * 1. Check for `Authorization: Bearer <token>` header payload decoding.
   * 2. If present, query the primary Auth database for document active state.
   * 3. Fallback to extracting the NextAuth getServerSession context.
   * 
   * @param {NextRequest} request - The incoming API router execution request
   * @returns {Promise<IUser | null>} Mongoose user document or null if unauthorized
   */
  static async getUserFromRequest(request: NextRequest): Promise<IUser | null> {
    try {
      // 1) Try Authorization: Bearer <token>
      const token = request.headers
        .get("authorization")
        ?.replace("Bearer ", "");

      if (token) {
        const payload = this.verifyToken(token);
        if (payload) {
          await connectDB();
          const userFromJwt = await getUserById(payload.userId);
          if (userFromJwt && userFromJwt.isActive) {
            // Check if session was invalidated (user was disabled)
            const tokenIssuedAt = payload.iat && typeof payload.iat === 'number' ? payload.iat * 1000 : Date.now(); // Convert to milliseconds
            if (userFromJwt.sessionInvalidatedAt && new Date(userFromJwt.sessionInvalidatedAt).getTime() > tokenIssuedAt) {
              // Session was invalidated, return null
              return null;
            }
            return userFromJwt;
          }
        }
      }

      // 2) Try NextAuth JWT token from cookie (reliable in App Router)
      const jwtToken = await getToken({ req: request, secret: AUTH_SECRET }).catch(() => null);
      if (jwtToken?.id) {
        await connectDB();
        const userFromJwtToken = await getUserById(jwtToken.id as string);
        if (userFromJwtToken && userFromJwtToken.isActive) {
          if (userFromJwtToken.sessionInvalidatedAt) {
            serverLogger.warn('[AuthService] Session invalidated for user:', userFromJwtToken.email);
            return null;
          }
          return userFromJwtToken;
        }
      }

      // 3) Fallback to NextAuth session (social login or credentials session)
      const session = await getServerSession(authOptions);
      if (session?.user) {
        const sessionUser = session.user;
        const userFromSession = sessionUser.id ? await getUserById(sessionUser.id) : null;
        if (userFromSession && userFromSession.isActive) {
          if (userFromSession.sessionInvalidatedAt) {
            serverLogger.warn('[AuthService] Session invalidated for user:', userFromSession.email);
            return null;
          }
          return userFromSession;
        } else {
            serverLogger.warn('[AuthService] User not found or inactive via session:', sessionUser.email);
        }
      }
      // No session — common path for guests / unauthenticated pre-login
      // requests on protected routes. The route layer's own 401 is the
      // signal; logging at warn level fires on every anonymous landing
      // and floods Cloud Logging with non-actionable noise.

      return null;
    } catch (error) {
      serverLogger.error("Auth error:", error);
      return null;
    }
  }

  /**
   * Check if user is admin
   */
  static async isAdmin(request: NextRequest): Promise<boolean> {
    const user = await this.getUserFromRequest(request);
    return user?.role === "admin";
  }

  /**
   * Check if user is authenticated
   */
  static async isAuthenticated(request: NextRequest): Promise<boolean> {
    const user = await this.getUserFromRequest(request);
    return !!user;
  }

  /**
   * Admin variant of {@link getUserFromRequest}: returns the hydrated User
   * doc only when authenticated AND `role === "admin"`. Returns null
   * otherwise. Routes drop the manual `getToken({req,secret})` fallback +
   * inline role check and just call this — `getUserFromRequest` already
   * walks the Bearer → NextAuth-getToken → NextAuth-session ladder.
   */
  static async getAdminFromRequest(request: NextRequest): Promise<IUser | null> {
    const user = await this.getUserFromRequest(request);
    return user && user.role === "admin" ? user : null;
  }
}
