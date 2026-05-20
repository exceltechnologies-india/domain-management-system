/**
 * API Response Wrapper
 * Utility to wrap API responses with security headers
 * Use this for API routes that don't use withAdminSecurity
 */

import { NextRequest, NextResponse } from "next/server";
import { addSecurityHeaders } from "@/lib/security-headers";
import { serverLogger } from "@/lib/server-logger";

/**
 * Wrap API response with security headers
 * Usage:
 * export async function GET(request: NextRequest) {
 *   const data = { success: true };
 *   return withSecurityHeaders(NextResponse.json(data));
 * }
 */
export function withSecurityHeaders(response: NextResponse): NextResponse {
  return addSecurityHeaders(response);
}

/**
 * Create a secure JSON response
 * Usage:
 * export async function GET(request: NextRequest) {
 *   return secureJsonResponse({ success: true });
 * }
 */
export function secureJsonResponse(
  data: unknown,
  status: number = 200
): NextResponse {
  const response = NextResponse.json(data, { status });
  return addSecurityHeaders(response);
}

/**
 * secureErrorResponse: Standardized secure error handler for API routes.
 * 
 * Key Features:
 * 1. Internal Logging: Automatically catches and logs errors with server-side tracing.
 * 2. Production Masking: In production environments, sensitive 500-level errors are
 *    masked with generic messages to prevent internal system disclosure (e.g., DB errors).
 * 3. Security Headers: Wraps the response with HTTP security headers.
 * 
 * @param error The error message to return (masked in production if 500+)
 * @param status The HTTP status code
 * @param code A stable error code for client-side handling (e.g., 'VALIDATION_ERROR')
 * @param errorDetails Optional metadata for internal logging (never sent to client)
 */
export function secureErrorResponse(
  error: string,
  status: number = 500,
  code?: string,
  errorDetails?: unknown
): NextResponse {
  // 1. Log the error internally with full details for troubleshooting
  if (status >= 500) {
    serverLogger.error(`[API-ERROR] ${code || "UNKNOWN_ERROR"} (${status}): ${error}`, errorDetails);
  } else {
    serverLogger.warn(`[API-WARN] ${code || "CLIENT_ERROR"} (${status}): ${error}`, errorDetails);
  }

  // 2. Determine message to send to client (Defense: mask info disclosure)
  const isProduction = process.env.NODE_ENV === "production";
  const clientMessage = (isProduction && status >= 500 && status !== 503) 
    ? "An internal server error occurred" 
    : error;

  const response = NextResponse.json(
    {
      error: clientMessage,
      code: code || "ERROR",
      timestamp: new Date().toISOString(),
      ...(status === 400 && errorDetails ? { details: errorDetails } : {}),
    },
    { status }
  );
  
  // 3. Apply standard security headers (CSP, HSTS, etc.)
  return addSecurityHeaders(response);
}

/**
 * Higher-order function to wrap API route handlers with security headers
 * Usage:
 * export const GET = withSecureHeaders(async (request: NextRequest) => {
 *   return NextResponse.json({ success: true });
 * });
 */
export function withSecureHeaders(
  handler: (request: NextRequest) => Promise<NextResponse>
) {
  return async (request: NextRequest): Promise<NextResponse> => {
    const response = await handler(request);
    return addSecurityHeaders(response);
  };
}

