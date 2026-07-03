import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { DirectAdminService } from "@/lib/directadmin";
import { secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/hosting/sso?username=<da-user>
 *
 * Admin-only impersonation endpoint. Mints a one-time DirectAdmin login
 * URL for any customer's DA account and redirects the admin's browser to
 * it — same underlying `getOneTimeLoginUrl` helper the customer-facing
 * `/api/user/hosting/sso` uses, but without the email-ownership check.
 *
 * Why this exists: operator asked for a way to help customers hands-on
 * (fix a broken cron in their site, restore from a backup, adjust an
 * MX record) without needing the customer's DA password. Customer's own
 * SSO endpoint is scoped to their own username; this one is the admin
 * mirror.
 *
 * Key differences vs `/api/user/hosting/sso`:
 *
 *   1. Auth = admin session (via `AuthService.getAdminFromRequest`),
 *      not customer session.
 *   2. No ownership check — admin can log into ANY DA account by
 *      username. That's the whole point.
 *   3. Suspended accounts are STILL accessible (the customer SSO route
 *      blocks them). An admin may need to enter a suspended account to
 *      investigate the reason for suspension, restore data, or unsuspend
 *      from inside DA — blocking would defeat the tool.
 *   4. Every access is logged at INFO with structured meta (adminEmail,
 *      targetUsername, timestamp) so SystemLog carries the audit trail —
 *      "which admin accessed which customer's panel and when." Load-
 *      bearing for accountability + post-incident forensics if a
 *      customer disputes an action taken inside their DA panel.
 */
export async function GET(request: NextRequest) {
  try {
    const adminUser = await AuthService.getAdminFromRequest(request);
    if (!adminUser) {
      serverLogger.warn("[Admin-SSO] Access attempt without admin session");
      return handleError(request, "Unauthorized: admin session required", 401, "AUTH_REQUIRED");
    }

    const { searchParams } = new URL(request.url);
    const targetUsername = (searchParams.get("username") || "").trim();

    if (!targetUsername) {
      return handleError(
        request,
        "Missing required query param: username",
        400,
        "USERNAME_REQUIRED"
      );
    }

    // Confirm the DA account exists before minting a login URL. Catches
    // typos + already-terminated accounts; also warms the config so the
    // audit line below can log the target customer's email alongside the
    // username (helps future forensics — "which customer did admin X log
    // in as").
    let targetEmail: string | undefined;
    let isSuspended = false;
    try {
      const targetConfig = await DirectAdminService.getUserConfig(targetUsername);
      targetEmail = targetConfig.email;
      isSuspended = targetConfig.suspended === "yes";
    } catch (err) {
      serverLogger.error(
        `[Admin-SSO] DA getUserConfig failed for '${targetUsername}' — cannot verify existence:`,
        err instanceof Error ? err.message : String(err)
      );
      return handleError(
        request,
        `Could not verify DA account '${targetUsername}'. It may not exist or DA is unreachable.`,
        400,
        "VERIFICATION_ERROR"
      );
    }

    // Audit log — admin identity + target + suspension state, all in one
    // structured entry so SystemLog can be queried later ("show me every
    // admin-SSO access in the last 30 days"). `service: 'auth'` routes
    // this row to the Integration Health "Authentication" provider so a
    // spike in admin-SSO activity is visible to operators (in case an
    // admin cookie is stolen and used to fan out into customer panels).
    serverLogger.info(
      `🔐 [Admin-SSO] Admin ${adminUser.email} logging into DA account '${targetUsername}'${isSuspended ? " (SUSPENDED)" : ""} on behalf of customer ${targetEmail ?? "<unknown>"}`,
      {
        service: "auth",
        adminEmail: adminUser.email,
        adminId: String(adminUser._id ?? ""),
        targetDaUsername: targetUsername,
        targetCustomerEmail: targetEmail,
        targetIsSuspended: isSuspended,
      }
    );

    const ssoUrl = await DirectAdminService.getOneTimeLoginUrl(targetUsername);
    return NextResponse.redirect(ssoUrl);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    serverLogger.error("[Admin-SSO] Route error:", message);
    return handleError(request, "Failed to initiate DirectAdmin session", 500, "SSO_FAILED");
  }
}

/**
 * Helper to handle errors based on request type (Browser vs API). Mirrors
 * the pattern in the customer SSO route so admin errors also render as
 * a friendly page when opened via a plain browser tab (the admin-panel
 * menu item opens in a new tab, so browser-target Accept header wins).
 */
function handleError(request: NextRequest, message: string, status: number, code: string) {
  const accept = request.headers.get("accept") || "";
  if (accept.includes("text/html")) {
    const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || "app.anutech.in";
    const proto = request.headers.get("x-forwarded-proto") || "https";
    const url = new URL("/hosting/error", `${proto}://${host}`);
    url.searchParams.set("code", code);
    url.searchParams.set("message", message);
    return NextResponse.redirect(url.toString());
  }
  return secureErrorResponse(message, status, code);
}
