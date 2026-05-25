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
 * Top-level error handler for /api/payments/verify.
 *
 * Reaching this function means signature/status/amount checks already
 * passed (those return NextResponses directly from `verifyRazorpayPayment`
 * — they don't throw). So every error that lands here is a provisioning-
 * side failure: RC/DA wrapper threw, Mongo write failed, etc.
 *
 * The earlier shape branched on `error.message.includes("Invalid payment
 * signature")`-style strings to pick one of seven error copies, but no
 * caller in the codebase throws those exact strings — verification helpers
 * return responses, the RC/DA wrappers now return typed outcomes, and the
 * Razorpay SDK throws its own wording ("Failed to fetch payment details").
 * The chain was dead defensive code. Removed in rescan-4 M1 slice 13
 * (M13 partial).
 *
 * Responsibility: record failure state on the order so support can pick
 * it up, then return a user-friendly 500. When an existing pending Order
 * is reachable, mark it via Order.updateOne (preserves M4's post-
 * provisioning state on the row). Otherwise fall back to creating one,
 * preserving real Razorpay identifiers.
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

  // Last resort: failure-state recording itself failed (no user, DB write
  // exploded, etc.). Return a clean 500 with the support contact.
  return NextResponse.json(
    {
      success: false,
      error:
        "Payment verification encountered an error. Please contact support if you were charged.",
      errorType: "verification_error",
      message:
        "Payment verification failed. Please contact support if the issue persists.",
      supportContact: SUPPORT_EMAIL,
    },
    { status: 500 }
  );
}
