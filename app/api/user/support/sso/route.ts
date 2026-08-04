import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { buildSupportSsoRedirectUrl } from "@/lib/integrations/support-sso";
import { rateLimiters, rateLimitResponse } from "@/lib/rate-limit";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = "force-dynamic";

// Phase 1 integration: redirects an already-logged-in customer straight into
// the Support Panel (DSP), auto-authenticated via a short-lived signed token.
// See lib/integrations/support-sso.ts.
export async function GET(request: NextRequest) {
  const user = await AuthService.getUserFromRequest(request);
  if (!user) {
    return NextResponse.redirect(new URL("/login?callbackUrl=/dashboard/support", request.url));
  }

  const userId = user._id.toString();
  const rl = await rateLimiters.api.checkKey(`support_sso:${userId}`);
  if (!rl.allowed) {
    return rateLimitResponse(rl, {
      message: "Too many requests. Please try again shortly.",
    });
  }

  try {
    const redirectUrl = buildSupportSsoRedirectUrl({
      id: userId,
      email: user.email,
      name: `${user.firstName} ${user.lastName}`.trim(),
    });
    return NextResponse.redirect(redirectUrl);
  } catch (error) {
    serverLogger.error("[support-sso] Failed to build redirect", error);
    return NextResponse.redirect(new URL("/dashboard/support?error=sso_unavailable", request.url));
  }
}
