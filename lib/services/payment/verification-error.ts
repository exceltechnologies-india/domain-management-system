import { NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import Order from "@/models/Order";
import type { IOrder } from "@/models/Order";
import { serverLogger } from "@/lib/server-logger";
import type { IUser } from "@/models/User";
import type { CartItem } from "@/lib/types";

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "support@anutech.in";

export interface HandleVerificationErrorInput {
  error: unknown;
  user: IUser | null;
  cartItems: CartItem[];
  /** The pending Order /verify was working on, if it had been claimed. */
  existingOrder?: IOrder | null;
  /** Real Razorpay identifiers from the request, so the fallback doesn't lose tracking. */
  razorpay_order_id?: string;
  razorpay_payment_id?: string;
}

/**
 * Top-level error handler for /api/payments/verify. Two responsibilities:
 *
 * 1. If the failure is a provisioning-side error (not a payment-validation
 *    error): when an existing pending Order is reachable, mark it as
 *    needing support follow-up via Order.updateOne (preserving M4's
 *    post-provisioning state already on the row). Only when no existing
 *    Order is reachable do we fall back to creating a new one — and even
 *    then we preserve the real Razorpay identifiers when available.
 *
 * 2. Otherwise map the error to a user-friendly HTTP response.
 *
 * The earlier shape always created a brand-new Order with random ids +
 * literal "fallback_*" Razorpay fields + status:"completed", which
 * orphaned the pending Order (and any provisioning data M4 persisted on
 * it), duplicated rows for one payment, and lied about completion when
 * no domain was actually registered.
 */
export async function handleVerificationError(
  input: HandleVerificationErrorInput
): Promise<NextResponse> {
  const {
    error,
    user,
    cartItems,
    existingOrder,
    razorpay_order_id,
    razorpay_payment_id,
  } = input;

  serverLogger.error(
    "❌ [PAYMENT-VERIFY] Critical error in payment verification",
    error
  );

  const isPaymentError =
    error instanceof Error &&
    (error.message.includes("Invalid payment signature") ||
      error.message.includes("Payment not captured") ||
      error.message.includes("Payment amount mismatch") ||
      error.message.includes("Order ID mismatch"));

  if (!isPaymentError) {
    serverLogger.warn(
      "⚠️ [PAYMENT-VERIFY] Payment verified but provisioning encountered errors — recording failure state"
    );

    try {
      if (!user || !user._id) {
        serverLogger.error(
          "❌ [PAYMENT-VERIFY] Cannot record failure state — user not available"
        );
        throw error;
      }

      await connectDB();

      const hasHosting = cartItems.some((item) => item.itemType === "hosting");
      const hasDomain = cartItems.some(
        (item) => item.itemType === "domain" || !item.itemType
      );
      const userFacingMessage =
        hasHosting && hasDomain
          ? "Payment successful! Service registration and provisioning is being processed."
          : hasHosting
          ? "Payment successful! Hosting provisioning is being processed."
          : "Payment successful! Domain registration is being processed.";

      // Happy path: an existing pending Order is in scope. Update it in
      // place — preserves M4's post-provisioning state, keeps the real
      // Razorpay tracking, doesn't duplicate the row. Leaves status at
      // "processing" so admin / the self-heal worker can pick it up.
      if (existingOrder) {
        await Order.updateOne(
          { _id: existingOrder._id },
          {
            $set: {
              status: "processing",
              ...(razorpay_payment_id
                ? { razorpayPaymentId: razorpay_payment_id }
                : {}),
              "paymentVerification.verifiedAt": new Date(),
              "paymentVerification.paymentStatus": "captured_pending_support",
            },
          }
        );

        serverLogger.info(
          `✅ [PAYMENT-VERIFY] Pending order ${existingOrder.orderId} marked for support follow-up`
        );

        return NextResponse.json({
          success: true,
          message: userFacingMessage,
          orderId: existingOrder.orderId,
          invoiceNumber: existingOrder.invoiceNumber,
          registrationResults: cartItems.map((item) => ({
            domainName: item.domainName,
            status: "pending",
            error: "Registration pending",
          })),
          successfulDomains: [],
          pendingDomains: cartItems.map((item) => item.domainName),
          paymentStatus: "success",
          domainRegistrationStatus: "pending",
          requiresSupport: true,
        });
      }

      // No existing Order: defensive fallback for legacy flows where the
      // pending Order was never created. Preserve real Razorpay ids when
      // available; status stays "processing" (not "completed") because no
      // domain was registered.
      const fallbackOrderId = `ord_${Date.now()}_${Math.random()
        .toString(36)
        .substring(2, 8)}`;

      const totalAmount = cartItems.reduce(
        (sum, item) => sum + (item.price || 0) * (item.registrationPeriod || 1),
        0
      );

      const fallbackOrder = new Order({
        orderId: fallbackOrderId,
        userId: user._id,
        paymentId: `pay_${Date.now()}_${Math.random()
          .toString(36)
          .substring(2, 8)}`,
        razorpayOrderId: razorpay_order_id || "fallback_order",
        razorpayPaymentId: razorpay_payment_id || "fallback_payment",
        razorpaySignature: "fallback_signature",
        amount: totalAmount,
        currency: "INR",
        status: "processing",
        domains: cartItems.map((item) => ({
          domainName: item.domainName,
          price: item.price,
          currency: item.currency || "INR",
          registrationPeriod: item.registrationPeriod || 1,
          periodUnit:
            item.periodUnit ||
            (item.itemType === "hosting" ? "months" : "years"),
          status: "pending",
          bookingStatus: [
            {
              step: "payment_verified",
              message:
                "Payment verified - Domain registration pending due to system error",
              timestamp: new Date(),
              progress: 30,
            },
          ],
          error: "Domain registration pending - Please contact support",
        })),
        successfulDomains: [],
        paymentVerification: {
          verifiedAt: new Date(),
          paymentStatus: "captured_pending_support",
          paymentAmount: totalAmount,
          paymentCurrency: "INR",
          razorpayOrderId: razorpay_order_id || "fallback_order",
        },
      });

      await fallbackOrder.save();
      serverLogger.info(
        `✅ [PAYMENT-VERIFY] Fallback order saved PON=${fallbackOrder.purchaseOrderNumber}`
      );

      return NextResponse.json({
        success: true,
        message: userFacingMessage,
        orderId: fallbackOrder.orderId,
        invoiceNumber: fallbackOrder.invoiceNumber,
        registrationResults: cartItems.map((item) => ({
          domainName: item.domainName,
          status: "pending",
          error: "Registration pending",
        })),
        successfulDomains: [],
        pendingDomains: cartItems.map((item) => item.domainName),
        paymentStatus: "success",
        domainRegistrationStatus: "pending",
        requiresSupport: true,
      });
    } catch (fallbackError) {
      serverLogger.error(
        "❌ [PAYMENT-VERIFY] Failed to record failure state",
        fallbackError
      );
    }
  }

  let errorMessage = "Payment verification failed";
  let statusCode = 500;
  let errorType = "verification_error";

  if (error instanceof Error) {
    if (error.message.includes("Invalid payment signature")) {
      errorMessage = "Payment signature verification failed. Please try again.";
      statusCode = 400;
      errorType = "signature_error";
    } else if (error.message.includes("Payment not found")) {
      errorMessage =
        "Payment not found. Please contact support if you were charged.";
      statusCode = 404;
      errorType = "payment_not_found";
    } else if (error.message.includes("Payment already processed")) {
      errorMessage = "This payment has already been processed.";
      statusCode = 409;
      errorType = "duplicate_payment";
    } else if (error.message.includes("Payment not captured")) {
      errorMessage =
        "Payment was not captured successfully. Please try again.";
      statusCode = 402;
      errorType = "payment_not_captured";
    } else if (error.message.includes("Payment amount mismatch")) {
      errorMessage =
        "Payment amount verification failed. Please contact support.";
      statusCode = 400;
      errorType = "amount_mismatch";
    } else if (error.message.includes("Card declined")) {
      errorMessage =
        "Your card was declined. Please try a different payment method.";
      statusCode = 402;
      errorType = "card_declined";
    } else if (
      error.message.includes("Network error") ||
      error.message.includes("timeout")
    ) {
      errorMessage =
        "Network error occurred. Please check your payment status in a few minutes.";
      statusCode = 503;
      errorType = "network_error";
    } else {
      // Generic copy for unmapped error types — raw error.message goes only
      // to serverLogger, not to the user-facing response.
      errorMessage =
        "Payment verification encountered an error. Please contact support if you were charged.";
      serverLogger.error(
        "❌ [PAYMENT-VERIFY] Unhandled error type:",
        error.message,
        error
      );
    }
  }

  return NextResponse.json(
    {
      success: false,
      error: errorMessage,
      errorType,
      message:
        "Payment verification failed. Please contact support if the issue persists.",
      supportContact: SUPPORT_EMAIL,
    },
    { status: statusCode }
  );
}
