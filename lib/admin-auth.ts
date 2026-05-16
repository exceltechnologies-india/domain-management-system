import { AUTH_SECRET } from "@/lib/auth-secret";
import { serverLogger } from "@/lib/server-logger";
import { NextRequest } from "next/server";
import connectDB from "@/lib/mongodb";
import { getUserById } from "@/lib/services/users";
import User from "@/models/User";
import jwt from "jsonwebtoken";
import { logAdminAction } from "@/lib/audit-log";

export interface AuthResult {
  valid: boolean;
  error?: string;
  user?: any;
}

/**
 * Verify if the request is from an authenticated admin user
 */
export async function verifyAdminAuth(
  request: NextRequest
): Promise<AuthResult> {
  try {
    // Get token from cookies
    const token = request.cookies.get("token")?.value;

    if (!token) {
      return {
        valid: false,
        error: "No authentication token provided. Please log in.",
      };
    }

    // Verify JWT token
    const decoded = jwt.verify(
      token,
      AUTH_SECRET
    ) as any;

    if (!decoded.userId) {
      return {
        valid: false,
        error: "Invalid token format",
      };
    }

    // Connect to database and verify user exists
    await connectDB();
    const user = await getUserById(decoded.userId);

    if (!user) {
      return {
        valid: false,
        error: "User not found",
      };
    }

    if (!user.isActive) {
      return {
        valid: false,
        error: "Account is deactivated",
      };
    }

    if (user.role !== "admin") {
      return {
        valid: false,
        error: "Access denied. Admin privileges required.",
      };
    }

    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
      request.headers.get("x-real-ip") ||
      (request as any).ip ||
      "unknown";

    void logAdminAction({
      userId: user._id.toString(),
      userEmail: user.email,
      action: `${request.method}_${request.nextUrl.pathname.split("/").pop()?.toUpperCase() || "UNKNOWN"}`,
      resource: request.nextUrl.pathname,
      method: request.method,
      path: request.nextUrl.pathname,
      ip,
      userAgent: request.headers.get("user-agent") || "",
      success: true,
      metadata: { query: Object.fromEntries(request.nextUrl.searchParams) },
    });

    return {
      valid: true,
      user: {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
      },
    };
  } catch (error) {
    serverLogger.error("Admin auth verification error:", error);
    return {
      valid: false,
      error: "Invalid or expired authentication token",
    };
  }
}

/**
 * Verify if the request is from any authenticated user (admin or regular user)
 */
export async function verifyUserAuth(
  request: NextRequest
): Promise<AuthResult> {
  try {
    const token = request.cookies.get("token")?.value;

    if (!token) {
      return {
        valid: false,
        error: "No authentication token provided",
      };
    }

    const decoded = jwt.verify(
      token,
      AUTH_SECRET
    ) as any;

    if (!decoded.userId) {
      return {
        valid: false,
        error: "Invalid token format",
      };
    }

    await connectDB();
    const user = await getUserById(decoded.userId);

    if (!user) {
      return {
        valid: false,
        error: "User not found",
      };
    }

    if (!user.isActive) {
      return {
        valid: false,
        error: "Account is deactivated",
        message:
          `Your account has been deactivated. Please contact our support team at ${process.env.SUPPORT_EMAIL || "support@anutech.in"} for assistance.`,
        supportEmail: process.env.SUPPORT_EMAIL || "support@anutech.in",
        isDeactivated: true,
      } as any;
    }

    return {
      valid: true,
      user: {
        id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
      },
    };
  } catch (error) {
    serverLogger.error("User auth verification error:", error);
    return {
      valid: false,
      error: "Invalid or expired authentication token",
    };
  }
}
