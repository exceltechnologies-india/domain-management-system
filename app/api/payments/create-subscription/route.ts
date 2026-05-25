import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { RazorpayService } from "@/lib/razorpay";
import { serverLogger } from "@/lib/server-logger";
import { validatedBody, z } from "@/lib/api-validation";

const createSubscriptionSchema = z.object({
  planId: z.string().min(1, "Plan ID is required"),
  interval: z.enum(["monthly", "yearly"]).optional(),
  domainName: z.string().trim().min(3).max(253),
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

    const validation = await validatedBody(request, createSubscriptionSchema);
    if (!validation.ok) return validation.response;
    const { planId, interval, domainName } = validation.data;

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
      // Log full error server-side; return generic message to the client.
      // Razorpay errors can include account-id / key fragments + retry
      // tokens that don't belong in a user-facing response.
      serverLogger.error(
        "❌ [CREATE-SUBSCRIPTION] Razorpay subscription creation failed:",
        razorpayError
      );
      return NextResponse.json(
        { error: "Failed to create subscription. Please try again or contact support." },
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
