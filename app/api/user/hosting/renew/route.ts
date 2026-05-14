import { NextRequest, NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import Hosting from "@/models/Hosting";
import HostingPlan from "@/models/HostingPlan";
import Order from "@/models/Order";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { AuthService } from "@/lib/auth";
import { RazorpayService } from "@/lib/razorpay";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = 'force-dynamic';

/**
 * POST /api/user/hosting/renew
 * 
 * Initiates a manual renewal for a hosting account.
 * Creates a Razorpay order and a pending internal Order record.
 * Only supports 1-year (12 months) renewals.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
    }

    const { domainName } = await request.json();

    if (!domainName) {
      return secureErrorResponse("Domain name is required", 400, "INVALID_PARAM");
    }

    await connectDB();

    const hosting = await Hosting.findOne({
      userId: user._id,
      domainName: domainName.toLowerCase()
    });

    if (!hosting) {
      return secureErrorResponse("Hosting account not found", 404, "NOT_FOUND");
    }

    if (hosting.status === 'terminated') {
      return secureErrorResponse(
        "Terminated hosting accounts cannot be renewed. Please contact support.",
        400,
        "HOSTING_TERMINATED"
      );
    }

    const RENEWABLE_STATUSES = ['active', 'expired', 'suspended'];
    if (!RENEWABLE_STATUSES.includes(hosting.status)) {
      return secureErrorResponse(
        "Hosting account is not eligible for renewal at this time.",
        400,
        "HOSTING_NOT_RENEWABLE"
      );
    }

    if (hosting.status === 'active' && hosting.expiryDate) {
      const now = new Date();
      const msUntilExpiry = hosting.expiryDate.getTime() - now.getTime();
      const fifteenDaysInMs = 15 * 24 * 60 * 60 * 1000;
      if (msUntilExpiry > fifteenDaysInMs) {
        const daysRemaining = Math.ceil(msUntilExpiry / (24 * 60 * 60 * 1000));
        return secureErrorResponse(
          `Renewal is available within 15 days of expiry. Your hosting expires in ${daysRemaining} days.`,
          400,
          "TOO_EARLY_TO_RENEW"
        );
      }
    }

    const plan = await HostingPlan.findOne({ planId: hosting.planId });
    if (!plan) {
      return secureErrorResponse("Hosting plan not found", 404, "PLAN_NOT_FOUND");
    }

    // Business Rule: Renewals are 1 Year ONLY (12 months)
    const renewalMonths = 12;
    const price = plan.price * renewalMonths;

    // Generate unique local order ID using the renewal prefix 'rnw_' for recognition in verify/webhook
    const shortTs = Date.now().toString().slice(-10);
    const rand = Math.random().toString(36).substring(2, 8);
    const orderId = `rnw_${shortTs}_${rand}`;

    // 1. Create Razorpay order
    const razorpayOrder = await RazorpayService.createOrder(
      price,
      "INR",
      orderId,
      {
        type: "hosting_renewal",
        domain_name: hosting.domainName,
        user_id: user._id.toString()
      }
    );

    // 2. Create internal PENDING order record
    const order = new Order({
      orderId,
      userId: user._id,
      userEmail: user.email,
      userName: `${user.firstName} ${user.lastName}`,
      amount: price,
      currency: "INR",
      status: "pending",
      orderType: "renewal",
      razorpayOrderId: razorpayOrder.id,
      paymentId: "pending",
      razorpayPaymentId: "pending",
      razorpaySignature: "pending",
      domains: [{
        domainName: hosting.domainName,
        price: plan.price,
        currency: "INR",
        registrationPeriod: renewalMonths,
        periodUnit: "months",
        itemType: "hosting",
        hostingPlan: {
          planId: plan.planId,
          name: plan.name,
          serverPackage: plan.directAdminPackage
        },
        status: "pending",
        bookingStatus: [{
          step: "payment_verified",
          message: "Waiting for payment verification",
          timestamp: new Date(),
          progress: 10
        }]
      }]
    });

    await order.save();

    return secureJsonResponse({
      success: true,
      data: {
        orderId,
        razorpayOrderId: razorpayOrder.id,
        amount: price,
        currency: "INR",
        hostingDetails: {
          domainName: hosting.domainName,
          planName: plan.name,
          renewalPeriod: "1 Year"
        }
      }
    });

  } catch (error: any) {
    serverLogger.error("Hosting renewal error:", error);
    return secureErrorResponse(error.message || "Failed to initiate renewal", 500, "INTERNAL_ERROR");
  }
}
