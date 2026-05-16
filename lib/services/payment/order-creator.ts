import { NextResponse } from "next/server";
import mongoose from "mongoose";
import Order from "@/models/Order";
import Payment from "@/models/Payment";
import { serverLogger } from "@/lib/server-logger";
import { provisionCartItems } from "@/lib/services/payment/provisioner";
import {
  isDomainSupported,
  requiresAdditionalDetails,
  getDomainRequirements,
} from "@/lib/domainRequirements";
import type { IUser } from "@/models/User";
import type { CartItem, RazorpayPaymentDetails } from "@/lib/types";

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "support@anutech.in";

/**
 * Reject orders containing domains that require manual verification or are
 * unsupported. Returns ok:false with a fully-formed 400 response if any
 * such domains are present.
 */
export function validateNoRestrictedDomains(
  cartItems: CartItem[]
): { ok: true } | { ok: false; response: NextResponse } {
  const restrictedDomains: Array<{ domainName: string; requirements: unknown }> = [];
  for (const item of cartItems) {
    if (
      requiresAdditionalDetails(item.domainName) ||
      !isDomainSupported(item.domainName)
    ) {
      restrictedDomains.push({
        domainName: item.domainName,
        requirements: getDomainRequirements(item.domainName),
      });
    }
  }

  if (restrictedDomains.length === 0) return { ok: true };

  serverLogger.error(
    `❌ [PAYMENT-VERIFY] Payment rejected — ${restrictedDomains.length} restricted domain(s) in cart`
  );
  return {
    ok: false,
    response: NextResponse.json(
      {
        success: false,
        error: "Payment rejected",
        message:
          "Some domains in your order require additional verification and cannot be processed automatically.",
        restrictedDomains: restrictedDomains.map((d) => ({
          domainName: d.domainName,
          reason: "Additional verification required",
        })),
        supportContact: `Please contact ${SUPPORT_EMAIL} for assistance with these domains.`,
      },
      { status: 400 }
    ),
  };
}

export interface CreateCompletedOrderInput {
  user: IUser;
  cartItems: CartItem[];
  razorpay_order_id?: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
  razorpay_subscription_id?: string;
  paymentDetails: RazorpayPaymentDetails;
}

export interface CreateCompletedOrderResult {
  order: any;
  orderId: string;
  paymentId: string;
  registrationTotalAmount: number;
  registrationResults: any;
  orderDomains: any;
  finalSuccessfulDomains: any;
  pendingDomains: any[];
  failedDomains: any[];
  orderStatus: "completed";
}

/**
 * Creates a new Order + Payment pair atomically after successful payment
 * verification. Generates IDs, infers the order type, provisions cart items,
 * and persists everything in one Mongo transaction.
 *
 * Caller is responsible for:
 *   - Auth + input validation
 *   - Calling validateNoRestrictedDomains() first
 *   - Idempotency / existing-order handling
 *   - Building the user-facing success response
 *   - Triggering Zoho + post-payment tasks afterwards
 */
export async function createCompletedOrder(
  input: CreateCompletedOrderInput
): Promise<CreateCompletedOrderResult> {
  const {
    user,
    cartItems,
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    razorpay_subscription_id,
    paymentDetails,
  } = input;

  const orderId = `ord_${Date.now()}_${Math.random()
    .toString(36)
    .substring(2, 8)}`;
  const paymentId = `pay_${Date.now()}_${Math.random()
    .toString(36)
    .substring(2, 8)}`;

  const registrationTotalAmount = cartItems.reduce(
    (total, item) => total + item.price * (item.registrationPeriod || 1),
    0
  );

  const pendingPaymentData = paymentDetails
    ? {
        userId: user._id,
        orderId,
        razorpayPaymentId: razorpay_payment_id,
        amount: registrationTotalAmount,
        currency: paymentDetails.currency || "INR",
        status: "completed",
      }
    : null;

  serverLogger.info(
    `🚀 [PAYMENT-VERIFY] Payment confirmed — starting provisioning. status=${paymentDetails.status}`
  );

  const {
    registrationResults,
    orderDomains,
    finalSuccessfulDomains,
    pendingDomains,
    failedDomains,
  } = await provisionCartItems({
    cartItems,
    user,
    orderId,
    razorpay_payment_id,
    razorpay_subscription_id,
  });

  const orderStatus = "completed" as const;

  const _hasDomains = cartItems.some(
    (i: CartItem) => !i.itemType || i.itemType === "domain"
  );
  const _hasHosting = cartItems.some((i: CartItem) => i.itemType === "hosting");
  const _hasTrial = cartItems.some(
    (i: CartItem) => i.itemType === "hosting" && (i as any).isTrial === true
  );
  const derivedOrderType:
    | "domain"
    | "hosting"
    | "bundle"
    | "hosting_trial"
    | "unknown" = _hasTrial
    ? "hosting_trial"
    : _hasDomains && _hasHosting
    ? "bundle"
    : _hasDomains
    ? "domain"
    : _hasHosting
    ? "hosting"
    : "unknown";

  const inferredFromPrefix =
    !_hasTrial &&
    (orderId.startsWith("ord_dh")
      ? "bundle"
      : orderId.startsWith("ord_d")
      ? "domain"
      : orderId.startsWith("ord_h")
      ? "hosting"
      : null);

  const finalOrderType = inferredFromPrefix || derivedOrderType;
  serverLogger.info(
    `🏷️  [PAYMENT-VERIFY] Order type resolved: ${finalOrderType}`
  );

  const order = new Order({
    orderId,
    userId: user._id,
    userName: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
    userEmail: user.email,
    paymentId,
    razorpayOrderId: razorpay_order_id,
    razorpayPaymentId: razorpay_payment_id,
    razorpaySignature: razorpay_signature,
    amount: registrationTotalAmount,
    currency: "INR",
    status: orderStatus,
    domains: orderDomains,
    successfulDomains: finalSuccessfulDomains,
    orderType: finalOrderType,
    paymentVerification: {
      verifiedAt: new Date(),
      paymentStatus: paymentDetails.status,
      paymentAmount: paymentDetails.amount,
      paymentCurrency: paymentDetails.currency,
      razorpayOrderId: paymentDetails.order_id,
    },
  });

  const dbSession = await mongoose.startSession();
  try {
    await dbSession.withTransaction(async () => {
      await order.save({ session: dbSession });
      if (pendingPaymentData) {
        await Payment.create([pendingPaymentData], { session: dbSession });
      }
    });
  } finally {
    await dbSession.endSession();
  }
  serverLogger.info(
    `✅ [PAYMENT-VERIFY] Order + Payment saved atomically [type=${finalOrderType}] PON=${order.purchaseOrderNumber}`
  );

  return {
    order,
    orderId,
    paymentId,
    registrationTotalAmount,
    registrationResults,
    orderDomains,
    finalSuccessfulDomains,
    pendingDomains,
    failedDomains,
    orderStatus,
  };
}
