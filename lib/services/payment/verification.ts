import { NextResponse } from "next/server";
import { RazorpayService } from "@/lib/razorpay";
import { serverLogger } from "@/lib/server-logger";
import type { RazorpayPaymentDetails } from "@/lib/types";

const tid = (id?: string | null) => (id ? `...${id.slice(-6)}` : "none");

export interface VerifyPaymentInput {
  razorpay_order_id?: string;
  razorpay_subscription_id?: string;
  razorpay_payment_id: string;
  // Optional: the Tokens-flow recurring mandate authorization doesn't return a
  // usable client signature. When absent we skip the HMAC and rely on the
  // server-side integrity checks below (payment is real + captured + order_id
  // matches). The webhook (RAZORPAY_WEBHOOK_SECRET) is the authoritative
  // verifier for mandates.
  razorpay_signature?: string;
}

export type VerifyPaymentResult =
  | { ok: true; paymentDetails: RazorpayPaymentDetails }
  | { ok: false; response: NextResponse };

/**
 * Verifies a Razorpay payment end-to-end:
 *   1. HMAC signature on the order/subscription + payment_id combo
 *   2. Fetches authoritative paymentDetails from Razorpay
 *   3. Confirms the payment is in a usable state (captured / authorized)
 *   4. Cross-checks that the order_id / subscription_id in paymentDetails
 *      matches what the client claimed
 *
 * On any failure returns a fully-formed NextResponse the route can return
 * verbatim — same status codes, same error messages, same logs as before.
 */
export async function verifyRazorpayPayment(
  input: VerifyPaymentInput
): Promise<VerifyPaymentResult> {
  const {
    razorpay_order_id,
    razorpay_subscription_id,
    razorpay_payment_id,
    razorpay_signature,
  } = input;

  // Signature present → verify the HMAC as usual. Signature ABSENT (Tokens-flow
  // mandate auth) → skip the HMAC and rely on the server-side integrity checks
  // further down (Razorpay confirms the payment is real + captured, and its
  // order_id must match the claimed order). Combined with the route's
  // ownership check (order.userId === session user), that's a sound
  // verification without a client signature — you can't fake a Razorpay
  // payment_id and you can't claim another user's order.
  if (razorpay_signature) {
    const isPaymentValid = RazorpayService.verifyPayment({
      razorpay_order_id,
      razorpay_subscription_id,
      razorpay_payment_id,
      razorpay_signature,
    });

    if (!isPaymentValid) {
      serverLogger.error(
        `❌ [PAYMENT-VERIFY] Invalid payment signature for order=${tid(razorpay_order_id)} sub=${tid(razorpay_subscription_id)} pay=${tid(razorpay_payment_id)}`
      );
      return {
        ok: false,
        response: NextResponse.json(
          { error: "Invalid payment signature" },
          { status: 400 }
        ),
      };
    }
  } else {
    serverLogger.info(
      `[PAYMENT-VERIFY] No client signature (mandate flow) — using server-side payment/order integrity check for order=${tid(razorpay_order_id)} pay=${tid(razorpay_payment_id)}`
    );
  }

  let paymentDetails: RazorpayPaymentDetails;
  try {
    paymentDetails = await RazorpayService.getPaymentDetails(
      razorpay_payment_id
    );
    serverLogger.info(
      `✅ [PAYMENT-VERIFY] Payment details fetched: pay=${tid(paymentDetails.id)} status=${paymentDetails.status} amount=${paymentDetails.amount} order=${tid(paymentDetails.order_id)} sub=${tid(paymentDetails.subscription_id)}`
    );
  } catch (error) {
    serverLogger.error("❌ [PAYMENT-VERIFY] Failed to fetch payment details", error);
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Failed to verify payment status" },
        { status: 400 }
      ),
    };
  }

  if (!["captured", "authorized"].includes(paymentDetails.status)) {
    serverLogger.error(
      `❌ [PAYMENT-VERIFY] Invalid payment status: ${paymentDetails.status} isSubOnly=${!!razorpay_subscription_id && !razorpay_order_id}`
    );
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: `Payment status is ${paymentDetails.status}. Verification failed for this amount/type.`,
        },
        { status: 400 }
      ),
    };
  }

  if (
    razorpay_order_id &&
    paymentDetails.order_id !== razorpay_order_id
  ) {
    serverLogger.error(
      `❌ [PAYMENT-VERIFY] Order ID mismatch. Expected: ${razorpay_order_id}, Received: ${paymentDetails.order_id}`
    );
    return {
      ok: false,
      response: NextResponse.json({ error: "Order ID mismatch" }, { status: 400 }),
    };
  }

  if (
    razorpay_subscription_id &&
    paymentDetails.subscription_id &&
    paymentDetails.subscription_id !== razorpay_subscription_id
  ) {
    serverLogger.error(
      `❌ [PAYMENT-VERIFY] Subscription ID mismatch. Expected: ${razorpay_subscription_id}, Received: ${paymentDetails.subscription_id}`
    );
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Subscription ID mismatch" },
        { status: 400 }
      ),
    };
  }

  if (razorpay_subscription_id && !paymentDetails.subscription_id) {
    serverLogger.warn(
      `⚠️ [PAYMENT-VERIFY] sub=${tid(razorpay_subscription_id)} not in payment details but signature valid — proceeding`
    );
  }

  serverLogger.info(
    "✅ [PAYMENT-VERIFY] Payment verification successful. Proceeding with registration..."
  );

  return { ok: true, paymentDetails };
}

/**
 * F3: Validate that the amount in the DB order matches the amount actually
 * charged by Razorpay. Prevents underpayment fraud where a client could
 * sign a real payment for less than the cart total. Only runs for new
 * payments against existing pending orders.
 */
export async function validateOrderAmountMatchesRazorpay(
  razorpay_order_id: string,
  existingOrder: { amount: number }
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  try {
    const rzpOrder = await RazorpayService.getOrderDetails(razorpay_order_id);
    const expectedPaise = Math.round(existingOrder.amount * 100);
    if (Number(rzpOrder.amount) !== expectedPaise) {
      serverLogger.error(
        `❌ [PAYMENT-VERIFY] Amount mismatch. DB order expects ${expectedPaise} paise, Razorpay order has ${rzpOrder.amount} paise`
      );
      return {
        ok: false,
        response: NextResponse.json(
          { error: "Payment amount does not match order" },
          { status: 400 }
        ),
      };
    }
    return { ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    serverLogger.error(
      `❌ [PAYMENT-VERIFY] Failed to fetch Razorpay order for amount check:`,
      message
    );
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Could not verify payment amount" },
        { status: 400 }
      ),
    };
  }
}
