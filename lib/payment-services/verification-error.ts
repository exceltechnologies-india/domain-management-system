import { NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import Order from "@/models/Order";
import { serverLogger } from "@/lib/server-logger";
import type { IUser } from "@/models/User";
import type { CartItem } from "@/lib/types";

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "support@anutech.in";

export interface HandleVerificationErrorInput {
  error: unknown;
  user: IUser | null;
  cartItems: CartItem[];
}

/**
 * Top-level error handler for /api/payments/verify. Two responsibilities:
 *
 * 1. If the failure is a provisioning-side error (not a payment-validation
 *    error), and the user is authenticated, save a "fallback" order that
 *    records the captured payment but flags every cart item as pending
 *    support follow-up. This guarantees we never lose a paid customer
 *    silently.
 *
 * 2. Otherwise map the error to a user-friendly HTTP response with an
 *    appropriate status code.
 */
export async function handleVerificationError(
  input: HandleVerificationErrorInput
): Promise<NextResponse> {
  const { error, user, cartItems } = input;

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
      "⚠️ [PAYMENT-VERIFY] Payment verified but provisioning encountered errors — attempting fallback order"
    );

    try {
      if (!user || !user._id) {
        serverLogger.error(
          "❌ [PAYMENT-VERIFY] Cannot create fallback order — user not available"
        );
        throw error;
      }

      await connectDB();

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
        razorpayOrderId: "fallback_order",
        razorpayPaymentId: "fallback_payment",
        razorpaySignature: "fallback_signature",
        amount: totalAmount,
        currency: "INR",
        status: "completed",
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
          paymentStatus: "completed",
          paymentAmount: totalAmount,
          paymentCurrency: "INR",
          razorpayOrderId: "fallback_order",
        },
      });

      await fallbackOrder.save();
      serverLogger.info(
        `✅ [PAYMENT-VERIFY] Fallback order saved PON=${fallbackOrder.purchaseOrderNumber}`
      );

      const hasHostingFallback = cartItems.some(
        (item) => item.itemType === "hosting"
      );
      const hasDomainFallback = cartItems.some(
        (item) => item.itemType === "domain" || !item.itemType
      );

      return NextResponse.json({
        success: true,
        message:
          hasHostingFallback && hasDomainFallback
            ? "Payment successful! Service registration and provisioning is being processed."
            : hasHostingFallback
            ? "Payment successful! Hosting provisioning is being processed."
            : "Payment successful! Domain registration is being processed.",
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
        "❌ [PAYMENT-VERIFY] Failed to create fallback order",
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
      errorMessage = `Payment verification encountered an error: ${error.message}`;
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
