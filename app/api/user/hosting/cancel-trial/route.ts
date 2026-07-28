import { NextRequest, NextResponse } from "next/server";
import { findUserHostingById } from "@/lib/services/hostings";
import { RazorpayService } from "@/lib/razorpay";
import { DirectAdminService } from "@/lib/directadmin";
import { AuthService } from "@/lib/auth";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { validatedBody, z } from "@/lib/api-validation";
import { Schemas } from "@/lib/validation";

const cancelTrialSchema = z.object({
  hostingId: Schemas.id,
});

export const dynamic = "force-dynamic";

/**
 * POST /api/user/hosting/cancel-trial
 * Body: { hostingId: string }
 *
 * Terminates a trial hosting immediately:
 * 1. Cancels Razorpay subscription (no future charge)
 * 2. Suspends DirectAdmin user
 * 3. Sets hosting status to terminated
 *
 * The Order record with orderType:'hosting_trial' is intentionally kept
 * so the one-trial-per-user lifetime limit remains in effect.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await AuthService.getUserFromRequest(request);
    if (!user) return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");

    const validation = await validatedBody(request, cancelTrialSchema);
    if (!validation.ok) return validation.response;
    const { hostingId } = validation.data;

    const hosting = await findUserHostingById(hostingId, user._id);

    if (!hosting || !hosting.isTrial) {
      return NextResponse.json({ error: "Trial hosting not found" }, { status: 404 });
    }

    if (["terminated", "failed"].includes(hosting.status)) {
      return NextResponse.json({ error: "Trial is already terminated" }, { status: 409 });
    }

    // 1a. Subscriptions-flow: cancel the Razorpay subscription so no charge
    // fires on day 15.
    if (hosting.subscriptionId) {
      try {
        await RazorpayService.cancelSubscription(hosting.subscriptionId);
        serverLogger.info(`[cancel-trial] Cancelled Razorpay subscription ${hosting.subscriptionId}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        serverLogger.error(`[cancel-trial] Failed to cancel Razorpay subscription: ${message}`);
        // Continue — we still terminate the hosting
      }
    }

    // 1b. Tokens-flow: revoke the stored mandate token so it's cleanly torn
    // down (Tokens-flow trials have a razorpayTokenId, not a subscriptionId).
    // Best-effort — terminating the hosting + autoRenew=false already stops the
    // recurring-charge cron; this is the clean teardown on top. Clear the local
    // id regardless so we never point at a dead/dangling token.
    if (hosting.razorpayTokenId && hosting.razorpayCustomerId) {
      try {
        await RazorpayService.revokeToken(hosting.razorpayCustomerId, hosting.razorpayTokenId);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        serverLogger.error(`[cancel-trial] Failed to revoke Razorpay token: ${message}`);
      }
    }

    // 2. Suspend DirectAdmin user
    if (hosting.directAdminUsername) {
      try {
        await DirectAdminService.suspendUser(hosting.directAdminUsername, "Trial cancelled by user");
        serverLogger.info(`[cancel-trial] Suspended DA user ${hosting.directAdminUsername}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        serverLogger.error(`[cancel-trial] Failed to suspend DA user: ${message}`);
      }
    }

    // 3. Terminate the hosting record
    hosting.status = "terminated";
    hosting.isTrial = false;
    hosting.autoRenew = false;
    hosting.billingType = "manual";
    hosting.subscriptionId = undefined;
    hosting.razorpayTokenId = undefined; // token revoked above; drop the dead id
    hosting.next_action_at = undefined;
    await hosting.save();

    serverLogger.info(`[cancel-trial] Trial terminated for hosting ${hostingId} (user ${user.email})`);

    return secureJsonResponse({ success: true });
  } catch (error: unknown) {
    serverLogger.error("Cancel trial error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
