import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { RazorpayService } from "@/lib/razorpay";
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

    const { planId, interval, domainName } = await request.json();

    if (!planId) {
      return NextResponse.json({ error: "Plan ID is required" }, { status: 400 });
    }
    
    if (!domainName) {
      return NextResponse.json({ error: "Domain Name is required" }, { status: 400 });
    }

    serverLogger.info(`💰 [CREATE-SUBSCRIPTION] Creating subscription for plan: ${planId} (${interval}) for domain: ${domainName}`);

    try {
      // Create Razorpay Subscription
      const subscription = await RazorpayService.createSubscription(planId, user.id, domainName);

      return NextResponse.json({
        success: true,
        subscriptionId: subscription.id,
        short_url: subscription.short_url,
        planId: planId,
        interval: interval
      });
    } catch (razorpayError: unknown) {
      serverLogger.error(
        "❌ [CREATE-SUBSCRIPTION] Razorpay subscription creation failed:",
        razorpayError
      );
      return NextResponse.json(
        { error: razorpayError instanceof Error ? razorpayError.message : "Failed to create subscription" },
        { status: 500 }
      );
    }
  } catch (error) {
    serverLogger.error("❌ [CREATE-SUBSCRIPTION] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
