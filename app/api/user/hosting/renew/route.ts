import { NextRequest } from "next/server";
import { findUserHosting } from "@/lib/services/hostings";
import { getPlanByPlanId } from "@/lib/services/hosting-plans";
import { hostingCharge } from "@/lib/pricing/hosting-price";
import { renewalCycle } from "@/lib/pricing/trial-plan";
import { createOrder } from "@/lib/services/orders";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { AuthService } from "@/lib/auth";
import { RazorpayService } from "@/lib/razorpay";
import { rateLimiters, rateLimitResponse } from "@/lib/rate-limit";
import { serverLogger } from "@/lib/server-logger";
import { validatedBody, z } from "@/lib/api-validation";

const renewSchema = z.object({
  domainName: z.string().trim().toLowerCase().min(3).max(253),
});

export const dynamic = 'force-dynamic';

/**
 * POST /api/user/hosting/renew
 * 
 * Initiates a manual renewal for a hosting account.
 * Creates a Razorpay order and a pending internal Order record.
 * Renews for one year, or for one month when the hosting was set up monthly
 * (`billingCycle: "monthly"`, a monthly Starter trial since 24 Sep 2026).
 */
export async function POST(request: NextRequest) {
  try {
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
    }

    // Per-user throttle: each call mints a pending Razorpay order + a DB row.
    // 5/min/user is enough for a real human re-trying the "Pay Now" button
    // but bounds a logged-in attacker from minting orders at scale.
    const rl = await rateLimiters.hostingRenewUpgrade.checkKey(
      `hosting_renew:${user._id}`
    );
    if (!rl.allowed) {
      return rateLimitResponse(rl, {
        limit: 5,
        message: "Too many renewal attempts. Please wait a minute and try again.",
      });
    }

    const validation = await validatedBody(request, renewSchema);
    if (!validation.ok) return validation.response;
    const { domainName } = validation.data;

    const hosting = await findUserHosting(String(user._id), {
      domainName,
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

    const plan = await getPlanByPlanId(hosting.planId);
    if (!plan) {
      return secureErrorResponse("Hosting plan not found", 404, "PLAN_NOT_FOUND");
    }

    // At ResellerOS's price + 18% GST (owner decision, 24 Sep 2026) — not
    // `plan.price`, the DMS figure decision 7 disregards. See
    // lib/pricing/hosting-price.ts. One year, unless the hosting says it renews
    // monthly; a row with no cycle is yearly, as every renewal was before.
    const cycle = renewalCycle(hosting.billingCycle);
    const charge = hostingCharge(plan.planId, cycle);
    if (!charge) {
      return secureErrorResponse(
        `Renewal for the "${plan.name}" plan can't be paid online: it is not on our price list. ` +
          "Nothing was charged. Please raise a ticket from Dashboard → Support and we will renew it for you.",
        409,
        "HOSTING_PLAN_UNPRICED"
      );
    }
    const renewalMonths = charge.months;
    const price = charge.inclGst;

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
    const order = await createOrder({
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
        price: charge.inclGst / charge.months,
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
          renewalPeriod: cycle === "monthly" ? "1 Month" : "1 Year"
        }
      }
    });

  } catch (error: unknown) {
    // Log the real error server-side; return a generic message to the
    // client. Razorpay / Mongoose / network errors can carry credential
    // fragments or stack-trace info that doesn't belong in a user-facing
    // response.
    serverLogger.error("Hosting renewal error:", error);
    return secureErrorResponse(
      "Failed to initiate renewal. Please try again or contact support.",
      500,
      "INTERNAL_ERROR"
    );
  }
}
