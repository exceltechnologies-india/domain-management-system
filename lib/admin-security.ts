import { AUTH_SECRET } from "@/lib/auth-secret";
/**
 * Enhanced Admin Security Utilities
 * Provides additional security layers for admin API routes
 */

import { NextRequest } from "next/server";
import { serverLogger } from "@/lib/server-logger";
import { getToken } from "next-auth/jwt";
import connectDB from "@/lib/mongodb";
import { getUserById, getUserWithPassword } from "@/lib/services/users";
import bcrypt from "bcryptjs";
import { getSetting, getSettingValue } from "@/lib/services/settings";
import { rateLimiters } from "@/lib/rate-limit";
import { logAdminAction, queryAuditLogs, type AuditLogEntry } from "@/lib/audit-log";

export interface AdminSecurityResult {
  allowed: boolean;
  error?: string;
  code?: string;
  user?: {
    id: string;
    email: string;
    firstName?: string;
    lastName?: string;
    role?: string;
  };
}

/**
 * Enhanced admin authentication with additional security checks
 */
export async function verifyAdminSecurity(
  request: NextRequest
): Promise<AdminSecurityResult> {
  try {
    // 1. Rate limiting check
    const rateLimit = await rateLimiters.admin.isAllowed(request);
    if (!rateLimit.allowed) {
      return {
        allowed: false,
        error: "Too many requests. Please try again later.",
        code: "RATE_LIMIT_EXCEEDED",
      };
    }

    // 2. Get authentication token
    const token = await getToken({
      req: request,
      secret: AUTH_SECRET,
      cookieName: "next-auth.session-token",
    });

    if (!token || !token.id) {
      return {
        allowed: false,
        error: "Authentication required",
        code: "AUTH_REQUIRED",
      };
    }

    // 3. Verify user exists and is active
    await connectDB();
    const user = await getUserById(token.id);

    if (!user) {
      return {
        allowed: false,
        error: "User not found",
        code: "USER_NOT_FOUND",
      };
    }

    if (!user.isActive) {
      return {
        allowed: false,
        error: "Account is deactivated",
        code: "ACCOUNT_DEACTIVATED",
      };
    }

    // 4. Verify admin role
    if (user.role !== "admin") {
      return {
        allowed: false,
        error: "Admin privileges required",
        code: "ADMIN_REQUIRED",
      };
    }

    // 5. IP whitelisting check (if enabled)
    const ipWhitelistEnabled = await checkIPWhitelistEnabled();
    if (ipWhitelistEnabled) {
      const userId = (user._id as { toString(): string } | undefined)?.toString() || user.id || "";
      const ipCheck = await verifyIPWhitelist(request, userId);
      if (!ipCheck.allowed) {
        // Log unauthorized access attempt
        await logSecurityEvent({
          type: "UNAUTHORIZED_IP_ACCESS",
          userId: userId,
          userEmail: user.email,
          ip: getClientIP(request),
          path: request.nextUrl.pathname,
          method: request.method,
        });

        return {
          allowed: false,
          error: "Access denied from this IP address",
          code: "IP_NOT_WHITELISTED",
        };
      }
    }

    // 6. Check for suspicious patterns
    const userId = (user._id as { toString(): string } | undefined)?.toString() || user.id || "";
    const suspiciousCheck = await checkSuspiciousActivity(request, userId);
    if (!suspiciousCheck.allowed) {
      return {
        allowed: false,
        error: "Suspicious activity detected",
        code: "SUSPICIOUS_ACTIVITY",
      };
    }

    return {
      allowed: true,
      user: {
        id: (user._id as { toString(): string } | undefined)?.toString() || user.id || "",
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
      },
    };
  } catch (error) {
    serverLogger.error("Admin security verification error:", error);
    return {
      allowed: false,
      error: "Security verification failed",
      code: "VERIFICATION_ERROR",
    };
  }
}

/**
 * Check if IP whitelisting is enabled
 */
async function checkIPWhitelistEnabled(): Promise<boolean> {
  try {
    await connectDB();
    const value = await getSettingValue("admin_ip_whitelist_enabled");
    return value === true || value === "true";
  } catch (error) {
    serverLogger.error("Error checking IP whitelist setting:", error);
    return false; // Default to disabled if error
  }
}

/**
 * Verify if client IP is whitelisted
 */
async function verifyIPWhitelist(
  request: NextRequest,
  userId: string
): Promise<{ allowed: boolean; reason?: string }> {
  try {
    await connectDB();
    const clientIP = getClientIP(request);

    // Get whitelisted IPs for this admin
    const whitelistSetting = await getSetting(`admin_ip_whitelist_${userId}`);

    if (!whitelistSetting) {
      // If no whitelist configured, allow (for backward compatibility)
      return { allowed: true };
    }

    const whitelistedIPs: string[] = Array.isArray(whitelistSetting.value)
      ? whitelistSetting.value
      : typeof whitelistSetting.value === "string"
      ? whitelistSetting.value.split(",").map((ip: string) => ip.trim())
      : [];

    // Check if IP matches any whitelisted IP or CIDR range
    const isAllowed = whitelistedIPs.some((whitelistedIP) => {
      if (whitelistedIP.includes("/")) {
        // CIDR notation
        return isIPInCIDR(clientIP, whitelistedIP);
      }
      return clientIP === whitelistedIP;
    });

    return {
      allowed: isAllowed,
      reason: isAllowed ? undefined : "IP not in whitelist",
    };
  } catch (error) {
    serverLogger.error("Error verifying IP whitelist:", error);
    return { allowed: true }; // Allow on error to prevent blocking legitimate users
  }
}

/**
 * Check for suspicious activity patterns
 */
async function checkSuspiciousActivity(
  request: NextRequest,
  userId: string
): Promise<{ allowed: boolean; reason?: string }> {
  try {
    // Check for rapid successive requests (potential automated attack)
    const recentRequests = await getRecentAdminRequests(userId, 60000); // Last 1 minute
    if (recentRequests.length > 50) {
      return {
        allowed: false,
        reason: "Too many requests in short time",
      };
    }

    // Check for unusual request patterns
    const userAgent = request.headers.get("user-agent") || "";
    if (!userAgent || userAgent.length < 10) {
      return {
        allowed: false,
        reason: "Invalid user agent",
      };
    }

    return { allowed: true };
  } catch (error) {
    serverLogger.error("Error checking suspicious activity:", error);
    return { allowed: true }; // Allow on error
  }
}

/**
 * Get client IP address from request
 */
export function getClientIP(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const realIP = request.headers.get("x-real-ip");
  const direct = (request as unknown as { ip?: string }).ip;

  if (forwarded) {
    // x-forwarded-for can contain multiple IPs, take the first one
    return forwarded.split(",")[0].trim();
  }

  return realIP || direct || "unknown";
}

/**
 * Check if IP is in CIDR range
 */
function isIPInCIDR(ip: string, cidr: string): boolean {
  try {
    const [network, prefixLength] = cidr.split("/");
    const prefix = parseInt(prefixLength, 10);

    const ipParts = ip.split(".").map(Number);
    const networkParts = network.split(".").map(Number);

    if (ipParts.length !== 4 || networkParts.length !== 4) {
      return false;
    }

    // Simple CIDR check (for IPv4)
    const mask = (0xffffffff << (32 - prefix)) >>> 0;
    const ipNum =
      (ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3];
    const networkNum =
      (networkParts[0] << 24) |
      (networkParts[1] << 16) |
      (networkParts[2] << 8) |
      networkParts[3];

    return (ipNum & mask) === (networkNum & mask);
  } catch (error) {
    return false;
  }
}

/**
 * Get recent admin requests from the audit log
 */
async function getRecentAdminRequests(
  userId: string,
  timeWindowMs: number
): Promise<AuditLogEntry[]> {
  const startDate = new Date(Date.now() - timeWindowMs);
  return queryAuditLogs({ userId, startDate, limit: 200 });
}

/**
 * Log security event to the audit log
 */
async function logSecurityEvent(event: {
  type: string;
  userId: string;
  userEmail: string;
  ip: string;
  path: string;
  method: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  await logAdminAction({
    userId: event.userId,
    userEmail: event.userEmail,
    action: event.type,
    resource: event.path,
    method: event.method,
    path: event.path,
    ip: event.ip,
    success: false,
    metadata: event.details,
  });
}

/**
 * Require re-authentication for sensitive operations.
 *
 * Callers pass the admin's current password in the `x-reauth-token` request header.
 * The password is verified with bcrypt against the stored hash — never trust it
 * without this check.
 */
export async function requireReAuth(
  request: NextRequest,
  userId: string
): Promise<{ required: boolean; passed: boolean }> {
  try {
    // Fetch first so we can distinguish password-based admins from social-login
    // (Google/Facebook) admins. Select password explicitly; most callers strip
    // it with select("-password").
    const user = await getUserWithPassword(userId);

    // Social-login / passwordless admins have no password to step up WITH, so a
    // password re-auth is impossible for them — a bcrypt compare would always
    // fail and lock them out of every sensitive action. Operator policy
    // (2026-08-03): their already-authenticated admin session is sufficient —
    // exempt them from the password step-up. Password-based admins still MUST
    // re-enter their current password (below).
    if (user && !user.password) {
      return { required: false, passed: true };
    }

    const currentPassword = request.headers.get("x-reauth-token");
    if (!currentPassword || !user || !user.password) {
      return { required: true, passed: false };
    }

    const isValid = await bcrypt.compare(currentPassword, user.password);
    return { required: true, passed: isValid };
  } catch (error) {
    serverLogger.error("Error checking re-auth:", error);
    // Fail closed — a verification error must not grant access
    return { required: true, passed: false };
  }
}

