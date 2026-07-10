import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { DirectAdminService } from "@/lib/directadmin";
import { secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { listHostingsForUser } from "@/lib/services/hostings";

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

    // 2. If a specific username is requested, verify ownership from OUR
    // records — NEVER from the DA account's email.
    //
    // ⚠️ SECURITY: this previously granted a one-time control-panel login to
    // `targetUsername` if the DA account's contact email matched the user's
    // email. Because the operator provisions many customers' DA accounts with
    // the same contact email (the reseller's own address), any customer could
    // pass ?username=<another customer's DA account> and get a login URL into
    // it — cross-tenant account takeover. Ownership is now the set of DA
    // usernames on Hosting docs this user owns (Hosting.userId) plus their own
    // linked directAdminUsername.
    if (targetUsername) {
       const ownedUsernames = new Set<string>();
       if (user.directAdminUsername) ownedUsernames.add(user.directAdminUsername);
       try {
          const ownedHostings = await listHostingsForUser(user._id, { limit: 100 });
          for (const h of ownedHostings) {
              const daU = (h as { directAdminUsername?: string }).directAdminUsername;
              if (daU && daU.trim()) ownedUsernames.add(daU.trim());
          }
       } catch (err) {
           serverLogger.error(`SSO ownership lookup failed for ${user.email}:`, err);
           return handleError(request, "Failed to verify account ownership.", 400, "VERIFICATION_ERROR");
       }

       if (ownedUsernames.has(targetUsername)) {
           finalUsername = targetUsername;
       } else {
           serverLogger.warn(`SSO Access Denied: User ${user.email} attempted to access ${targetUsername} (not owned in our records)`);
           return handleError(request, "Unauthorized: You do not own this hosting account.", 403, "OWNERSHIP_VERIFICATION_FAILED");
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
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    serverLogger.error("SSO Route Error:", message);
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
