import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { RazorpayService } from "@/lib/razorpay";
import { findUserHostingById } from "@/lib/services/hostings";
import { serverLogger } from "@/lib/server-logger";
import { validatedBody, z } from "@/lib/api-validation";
import { Schemas } from "@/lib/validation";

const cancelSubscriptionSchema = z.object({
  hostingId: Schemas.id,
});

// Force dynamic rendering
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    // Check authentication
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await validatedBody(request, cancelSubscriptionSchema);
    if (!result.ok) return result.response;
    const { hostingId } = result.data;

    // Find hosting
    const hosting = await findUserHostingById(hostingId, user.id);
    if (!hosting) {
      return NextResponse.json({ error: "Hosting service not found" }, { status: 404 });
    }

    if (!hosting.subscriptionId) {
      return NextResponse.json({ error: "No active subscription found for this hosting" }, { status: 400 });
    }

    serverLogger.info(`❌ [CANCEL-SUBSCRIPTION] Cancelling subscription ${hosting.subscriptionId} for hosting ${hostingId}`);

    try {
      // Cancel Razorpay Subscription
      await RazorpayService.cancelSubscription(hosting.subscriptionId);
      
      // Update Hosting status
      hosting.autoRenew = false;
      // We don't terminate immediately, just stop renewal.
      // hosting.status = "cancelled"; // Optional: if you want to show it as cancelled immediately
      await hosting.save();

      return NextResponse.json({
        success: true,
        message: "Subscription cancelled successfully. Hosting will expire at the end of the current term."
      });
    } catch (razorpayError: unknown) {
      // Log full error server-side; return generic message to the client
      // (Razorpay error strings can include subscription / account fragments).
      serverLogger.error(
        "❌ [CANCEL-SUBSCRIPTION] Razorpay cancellation failed:",
        razorpayError
      );
      return NextResponse.json(
        { error: "Failed to cancel subscription. Please try again or contact support." },
        { status: 500 }
      );
    }
  } catch (error) {
    serverLogger.error("❌ [CANCEL-SUBSCRIPTION] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
