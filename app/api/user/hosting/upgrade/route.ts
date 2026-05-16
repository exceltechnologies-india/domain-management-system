import { NextRequest } from "next/server";
import connectDB from "@/lib/mongodb";
import Hosting from "@/models/Hosting";
import { getPlanByPlanId } from "@/lib/services/hosting-plans";
import Order from "@/models/Order";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { AuthService } from "@/lib/auth";
import { RazorpayService } from "@/lib/razorpay";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = 'force-dynamic';

/**
 * POST /api/user/hosting/upgrade
 * Body: { domainName, targetPlanId }
 *
 * Creates a Razorpay order and a pending internal Order for a hosting plan upgrade.
 * The server re-computes the prorated amount — never trusts client-supplied amounts.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
    }

    const { domainName, targetPlanId } = await request.json();

    if (!domainName || !targetPlanId) {
      return secureErrorResponse("domainName and targetPlanId are required", 400, "INVALID_PARAM");
    }

    await connectDB();

    const hosting = await Hosting.findOne({
      userId: user._id,
      domainName: domainName.toLowerCase(),
    });

    if (!hosting) {
      return secureErrorResponse("Hosting account not found", 404, "NOT_FOUND");
    }

    if (hosting.status !== 'active') {
      return secureErrorResponse(
        "Only active hosting accounts can be upgraded",
        400,
        "NOT_ELIGIBLE"
      );
    }

    const remainingDays = Math.ceil(
      (hosting.expiryDate.getTime() - Date.now()) / 86_400_000
    );

    if (remainingDays <= 0) {
      return secureErrorResponse(
        "Hosting has expired. Please renew before upgrading.",
        400,
        "HOSTING_EXPIRED"
      );
    }

    const currentPlan = await getPlanByPlanId(hosting.planId);
    if (!currentPlan) {
      return secureErrorResponse("Current plan details not found", 404, "PLAN_NOT_FOUND");
    }

    const targetPlan = await getPlanByPlanId(targetPlanId, { activeOnly: true });
    if (!targetPlan) {
      return secureErrorResponse("Target plan not found", 404, "TARGET_PLAN_NOT_FOUND");
    }

    if (targetPlan.price <= currentPlan.price) {
      return secureErrorResponse(
        "Target plan must have a higher price than the current plan",
        400,
        "INVALID_UPGRADE"
      );
    }

    // Server-authoritative prorated calculation
    const proratedAmount = Math.round(
      (targetPlan.price - currentPlan.price) * remainingDays / 30
    );
    const chargeAmount = Math.max(100, proratedAmount);

    const shortTs = Date.now().toString().slice(-10);
    const rand = Math.random().toString(36).substring(2, 8);
    const orderId = `upg_${shortTs}_${rand}`;

    const razorpayOrder = await RazorpayService.createOrder(
      chargeAmount,
      "INR",
      orderId,
      {
        type: "hosting_upgrade",
        hosting_id: hosting._id.toString(),
        domain_name: hosting.domainName,
        from_plan: currentPlan.planId,
        to_plan: targetPlan.planId,
        user_id: user._id.toString(),
      }
    );

    const order = new Order({
      orderId,
      userId: user._id,
      userEmail: user.email,
      userName: `${user.firstName} ${user.lastName}`,
      amount: chargeAmount,
      currency: "INR",
      status: "pending",
      orderType: "hosting_upgrade",
      razorpayOrderId: razorpayOrder.id,
      paymentId: "pending",
      razorpayPaymentId: "pending",
      razorpaySignature: "pending",
      upgradeDetails: {
        hostingId: hosting._id.toString(),
        fromPlanId: currentPlan.planId,
        toPlanId: targetPlan.planId,
        remainingDays,
      },
      domains: [{
        domainName: hosting.domainName,
        price: chargeAmount,
        currency: "INR",
        registrationPeriod: 1,
        periodUnit: "months",
        itemType: "hosting",
        hostingPlan: {
          planId: targetPlan.planId,
          name: targetPlan.name,
          serverPackage: targetPlan.directAdminPackage,
        },
        status: "pending",
        bookingStatus: [{
          step: "payment_verified",
          message: "Waiting for payment verification",
          timestamp: new Date(),
          progress: 10,
        }],
      }],
    });

    await order.save();

    return secureJsonResponse({
      success: true,
      data: {
        orderId,
        razorpayOrderId: razorpayOrder.id,
        amount: chargeAmount,
        currency: "INR",
        upgradeDetails: {
          domainName: hosting.domainName,
          fromPlanName: currentPlan.name,
          toPlanName: targetPlan.name,
          remainingDays,
        },
      },
    });
  } catch (error: any) {
    serverLogger.error("[UPGRADE] Error creating upgrade order:", error.message || error);
    return secureErrorResponse(error.message || "Failed to initiate upgrade", 500, "INTERNAL_ERROR");
  }
}
