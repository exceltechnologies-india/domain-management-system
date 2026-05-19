/**
 * API Security Middleware
 * Provides security headers, request validation, and other security features
 */

import { NextRequest, NextResponse } from "next/server";
import { addSecurityHeaders } from "@/lib/security-headers";
import { serverLogger } from "@/lib/server-logger";

/**
 * Validate request size
 */
export function validateRequestSize(
  request: NextRequest,
  maxSize: number = 1024 * 1024 // 1MB default
): { valid: boolean; error?: string } {
  const contentLength = request.headers.get("content-length");

  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (size > maxSize) {
      return {
        valid: false,
        error: `Request body too large. Maximum size is ${maxSize / 1024}KB`,
      };
    }
  }

  return { valid: true };
}

/**
 * Sanitize error message for client
 */
export function sanitizeErrorMessage(error: unknown): string {
  // Don't expose internal errors to clients
  if (error instanceof Error) {
    // In production, return generic message
    if (process.env.NODE_ENV === "production") {
      return "An error occurred. Please try again later.";
    }
    // In development, return actual error
    return error.message;
  }

  if (typeof error === "string") {
    // Remove sensitive information
    return error
      .replace(/password[=:]\s*[^\s,]+/gi, "password=[REDACTED]")
      .replace(/token[=:]\s*[^\s,]+/gi, "token=[REDACTED]")
      .replace(/secret[=:]\s*[^\s,]+/gi, "secret=[REDACTED]");
  }

  return "An error occurred. Please try again later.";
}

/**
 * Create secure error response
 */
export function createErrorResponse(
  error: unknown,
  status: number = 500,
  code?: string
): NextResponse {
  const sanitizedError = sanitizeErrorMessage(error);

  const response = NextResponse.json(
    {
      error: sanitizedError,
      code: code || "ERROR",
      timestamp: new Date().toISOString(),
    },
    { status }
  );

  return addSecurityHeaders(response);
}

/**
 * Validate request method
 */
export function validateMethod(
  request: NextRequest,
  allowedMethods: string[]
): { valid: boolean; error?: string } {
  if (!allowedMethods.includes(request.method)) {
    return {
      valid: false,
      error: `Method ${request.method} not allowed. Allowed methods: ${allowedMethods.join(", ")}`,
    };
  }

  return { valid: true };
}

/**
 * Get request metadata for logging
 */
export function getRequestMetadata(request: NextRequest): {
  ip: string;
  userAgent: string;
  method: string;
  path: string;
  query: Record<string, string>;
} {
  const forwarded = request.headers.get("x-forwarded-for");
  const realIP = request.headers.get("x-real-ip");
  const ip = (request as unknown as { ip?: string }).ip || forwarded?.split(",")[0]?.trim() || realIP || "unknown";

  return {
    ip,
    userAgent: request.headers.get("user-agent") || "unknown",
    method: request.method,
    path: request.nextUrl.pathname,
    query: Object.fromEntries(request.nextUrl.searchParams),
  };
}

/**
 * Check if request is from allowed origin (for CORS)
 * Supports both environment variables and database settings
 */
export async function isAllowedOrigin(origin: string | null): Promise<boolean> {
  if (!origin) {
    return true; // Same-origin requests
  }

  // Try to get from database settings first
  try {
    const { connectToDatabase } = await import("@/lib/mongoose");
    const Settings = (await import("@/models/Settings")).default;
    
    await connectToDatabase();
    
    // Check if CORS protection is enabled
    const corsEnabled = await Settings.findOne({ key: "cors_protection_enabled" });
    if (corsEnabled?.value === true || corsEnabled?.value === "true") {
      // Get allowed origins from database
      const allowedOriginsSetting = await Settings.findOne({ key: "cors_allowed_origins" });
      if (allowedOriginsSetting?.value) {
        const allowedOrigins = Array.isArray(allowedOriginsSetting.value)
          ? allowedOriginsSetting.value
          : typeof allowedOriginsSetting.value === "string"
          ? allowedOriginsSetting.value.split(",").map((o: string) => o.trim())
          : [];
        
        return allowedOrigins.some((allowed: string) => {
          if (allowed.includes("*")) {
            // Wildcard support
            const pattern = allowed.replace(/\*/g, ".*");
            return new RegExp(`^${pattern}$`).test(origin);
          }
          return origin === allowed;
        });
      }
    }
  } catch (error) {
    // Fall back to environment variable if database check fails
    serverLogger.error("Error checking CORS settings from database:", error);
  }

  // Fall back to environment variable
  const allowedOrigins = (
    process.env.ALLOWED_ORIGINS ||
    process.env.NEXTAUTH_URL ||
    process.env.APP_URL ||
    ""
  ).split(",").filter(Boolean);

  return allowedOrigins.some((allowed) => {
    if (allowed.includes("*")) {
      // Wildcard support
      const pattern = allowed.replace(/\*/g, ".*");
      return new RegExp(`^${pattern}$`).test(origin);
    }
    return origin === allowed;
  });
}

/**
 * Create CORS headers
 */
export async function createCORSHeaders(
  request: NextRequest
): Promise<Record<string, string>> {
  const origin = request.headers.get("origin");

  const isAllowed = await isAllowedOrigin(origin);
  if (!isAllowed) {
    return {};
  }

  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Requested-With, X-Reauth-Token",
    "Access-Control-Max-Age": "86400", // 24 hours
  };

  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }

  return headers;
}

/**
 * Handle preflight OPTIONS request
 */
export async function handleOPTIONS(request: NextRequest): Promise<NextResponse> {
  const response = new NextResponse(null, { status: 204 });
  const corsHeaders = await createCORSHeaders(request);

  Object.entries(corsHeaders).forEach(([key, value]) => {
    response.headers.set(key, value);
  });

  return addSecurityHeaders(response);
}

