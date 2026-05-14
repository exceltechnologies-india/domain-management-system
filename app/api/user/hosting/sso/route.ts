import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { DirectAdminService } from "@/lib/directadmin";
import { secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = 'force-dynamic';

/**
 * GET /api/user/hosting/sso
 * Generates a one-time login URL and redirects the user to the DirectAdmin panel.
 */
export async function GET(request: NextRequest) {
  try {
    // 1. Authenticate user
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      serverLogger.warn("SSO Access Attempt: Unauthorized");
      return handleError(request, "Unauthorized", 401, "AUTH_REQUIRED");
    }

    const { searchParams } = new URL(request.url);
    const targetUsername = searchParams.get('username');

    let finalUsername = user.directAdminUsername;

    // 2. If a specific username is requested, verify ownership via email
    if (targetUsername) {
       // Security Check: Does this DA account belong to this user's email?
       try {
          const targetConfig = await DirectAdminService.getUserConfig(targetUsername);
          
          // Case-insensitive email comparison
          if (targetConfig.email && targetConfig.email.toLowerCase() === user.email.toLowerCase()) {
              finalUsername = targetUsername;
          } else if (targetUsername === user.directAdminUsername) {
              // It matches the explicitly linked account
              finalUsername = targetUsername;
          } else {
             serverLogger.warn(`SSO Access Denied: User ${user.email} attempted to access ${targetUsername} (Email mismatch: ${targetConfig.email})`);
             return handleError(request, "Unauthorized: You do not own this hosting account.", 403, "OWNERSHIP_VERIFICATION_FAILED");
          }
       } catch (err) {
           serverLogger.error(`SSO Verification Error for ${targetUsername}:`, err);
           return handleError(request, "Failed to verify account ownership.", 400, "VERIFICATION_ERROR");
       }
    }

    if (!finalUsername) {
      serverLogger.warn(`SSO Access Attempt: No hosting account for user ${user.email}`);
      return handleError(request,
        "No hosting account associated with this user.",
        404,
        "HOSTING_NOT_FOUND"
      );
    }

    // 3. Check if account is suspended
    try {
      const daConfig = await DirectAdminService.getUserConfig(finalUsername);
      if (daConfig.suspended === 'yes') {
        serverLogger.warn(`SSO Access Denied: Account suspended for user ${user.email} (Account: ${finalUsername})`);
        return handleError(request,
          "Hosting account is suspended. Access denied.",
          403,
          "ACCOUNT_SUSPENDED"
        );
      }
    } catch (checkError) {
       serverLogger.warn(`Failed to check suspension status for ${finalUsername}: ${checkError}`);
    }

    // 4. Generate the One-Time Login URL
    const ssoUrl = await DirectAdminService.getOneTimeLoginUrl(finalUsername);

    // 5. Redirect the user
    return NextResponse.redirect(ssoUrl);
  } catch (error: any) {
    serverLogger.error("SSO Route Error:", error.message);
    return handleError(request, "Failed to initiate DirectAdmin session", 500, "SSO_FAILED");
  }
}

/**
 * Helper to handle errors based on request type (Browser vs API)
 */
function handleError(request: NextRequest, message: string, status: number, code: string) {
  const accept = request.headers.get('accept') || '';
  
  if (accept.includes('text/html')) {
    // For browsers, redirect to themed error page
    // Use headers to construct absolute URL to avoid localhost issue behind proxies
    const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || 'app.anutech.in';
    const proto = request.headers.get('x-forwarded-proto') || 'https';
    
    const url = new URL('/hosting/error', `${proto}://${host}`);
    url.searchParams.set('code', code);
    url.searchParams.set('message', message);
    return NextResponse.redirect(url.toString());
  }

  // For API clients, return JSON
  return secureErrorResponse(message, status, code);
}
