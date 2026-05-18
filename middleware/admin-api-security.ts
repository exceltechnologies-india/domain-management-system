/**
 * Admin API Security Middleware
 * Enhanced security for admin API routes
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyAdminSecurity } from "@/lib/admin-security";
import { logAPIRequest } from "@/lib/audit-log";
import { addSecurityHeaders } from "@/lib/security-headers";
import {
  validateRequestSize,
  createErrorResponse,
} from "@/lib/api-security-middleware";
import {
  updateLastActivity,
  requiresSessionRotation,
  rotateSession,
} from "@/lib/session-activity";

/**
 * Enhanced admin API security middleware
 * Use this in admin API routes for maximum security
 */
/** The narrowed admin user surface that verifyAdminSecurity produces. */
interface AdminUser {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role?: string;
}

export async function withAdminSecurity(
  request: NextRequest,
  handler: (request: NextRequest, user: AdminUser) => Promise<NextResponse>
): Promise<NextResponse> {
  const startTime = Date.now();

  try {
    // 1. Handle OPTIONS preflight
    if (request.method === "OPTIONS") {
      const response = new NextResponse(null, { status: 204 });
      return addSecurityHeaders(response);
    }

    // 2. Validate request size (1MB limit for admin APIs)
    const sizeCheck = validateRequestSize(request, 1024 * 1024);
    if (!sizeCheck.valid) {
      return createErrorResponse(sizeCheck.error, 413, "REQUEST_TOO_LARGE");
    }

    // 3. Enhanced admin security verification
    const securityCheck = await verifyAdminSecurity(request);
    if (!securityCheck.allowed) {
      const response = createErrorResponse(
        securityCheck.error || "Access denied",
        401,
        securityCheck.code || "ACCESS_DENIED"
      );
      return response;
    }

    const user = securityCheck.user!;

    // 4. Check if session rotation is required for sensitive operations
    const needsRotation = requiresSessionRotation(
      request.nextUrl.pathname,
      request.method
    );
    if (needsRotation) {
      // Rotate session for sensitive operations
      await rotateSession(user.id);
    } else {
      // Update last activity for regular operations
      await updateLastActivity(user.id);
    }

    // 5. Execute handler
    const response = await handler(request, user);

    // 6. Calculate execution time
    const executionTime = Date.now() - startTime;

    // 7. Log the request
    await logAPIRequest(
      request,
      user,
      response.status,
      executionTime
    ).catch((err) => {
      console.error("Error logging API request:", err);
    });

    // 8. Add security headers
    return addSecurityHeaders(response);
  } catch (error: unknown) {
    const executionTime = Date.now() - startTime;
    const errMessage = error instanceof Error ? error.message : String(error);

    // Log error
    try {
      const securityCheck = await verifyAdminSecurity(request);
      if (securityCheck.allowed && securityCheck.user) {
        await logAPIRequest(
          request,
          securityCheck.user,
          500,
          executionTime,
          errMessage
        );
      }
    } catch (logError) {
      console.error("Error logging error:", logError);
    }

    // Return sanitized error
    return createErrorResponse(error, 500, "INTERNAL_ERROR");
  }
}

/**
 * Simplified wrapper for admin API routes
 * Usage:
 * export async function GET(request: NextRequest) {
 *   return withAdminSecurity(request, async (req, user) => {
 *     // Your handler code here
 *     return NextResponse.json({ success: true });
 *   });
 * }
 */
export { withAdminSecurity as default };

