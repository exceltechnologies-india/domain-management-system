import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { RazorpayService } from "@/lib/razorpay";
import Hosting from "@/models/Hosting";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    // Check authentication
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { hostingId } = await request.json();

    if (!hostingId) {
      return NextResponse.json({ error: "Hosting ID is required" }, { status: 400 });
    }

    // Find hosting
    const hosting = await Hosting.findOne({ _id: hostingId, userId: user.id });
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
      serverLogger.error(
        "❌ [CANCEL-SUBSCRIPTION] Razorpay cancellation failed:",
        razorpayError
      );
      return NextResponse.json(
        { error: razorpayError instanceof Error ? razorpayError.message : "Failed to cancel subscription" },
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
