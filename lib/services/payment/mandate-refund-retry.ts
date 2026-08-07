/**
 * Retry sweep for FAILED mandate-validation refunds (the ₹2 trial CIT auth).
 *
 * Why this exists: the tokens/manual trial webhook refunds the ₹2
 * mandate-validation charge INLINE, exactly once, immediately after the payment
 * is captured (see app/razorpay/webhook/route.ts handleMandateValidationCaptured).
 * A just-captured recurring-auth payment can intermittently reject a refund at
 * that instant (both `optimum` and `normal` speeds), which stamps
 * `Order.mandateRefundStatus='failed'` — and there was NO retry, so a transient
 * blip left the ₹2 permanently un-refunded (a real money-loss in live).
 *
 * This sweep re-attempts those refunds. Because the payment stays fully
 * refundable, a retry a few minutes later reliably succeeds. It is idempotent:
 * if Razorpay already shows a refund (a prior sweep OR a manual dashboard
 * refund), it reconciles the Order to `processed` instead of double-refunding.
 *
 * Invoked by the `retry-mandate-refunds` worker (Cloud Scheduler); safe to run
 * as often as desired — it no-ops when nothing is in the `failed` state.
 */
import connectDB from "@/lib/mongodb";
import Order from "@/models/Order";
import { RazorpayService } from "@/lib/razorpay";
import { serverLogger } from "@/lib/server-logger";

// Real Razorpay payment ids are `pay_` + alphanumerics, no underscores. The
// legacy synthetic `Order.paymentId` (e.g. `pay_1785837394098_9boc9s`) is NOT a
// Razorpay id and must never be handed to the refund API — but we read the REAL
// id from `Order.razorpayPaymentId`, so this is a belt-and-suspenders guard.
const REAL_RAZORPAY_PAYMENT_ID = /^pay_[A-Za-z0-9]+$/;

export interface RetryRefundResult {
  scanned: number;
  refunded: number; // freshly refunded on this run
  alreadyRefunded: number; // Razorpay already had a refund → order reconciled
  skipped: number; // no usable real Razorpay payment id
  stillFailing: number; // retry attempted but Razorpay rejected again
}

export async function retryFailedMandateRefunds(
  opts?: { limit?: number }
): Promise<RetryRefundResult> {
  await connectDB();
  const limit = opts?.limit ?? 50;

  const orders = await Order.find({ mandateRefundStatus: "failed" })
    .sort({ createdAt: 1 })
    .limit(limit);

  const res: RetryRefundResult = {
    scanned: orders.length,
    refunded: 0,
    alreadyRefunded: 0,
    skipped: 0,
    stillFailing: 0,
  };

  for (const order of orders) {
    const paymentId = order.razorpayPaymentId;
    if (!paymentId || !REAL_RAZORPAY_PAYMENT_ID.test(paymentId)) {
      res.skipped += 1;
      serverLogger.warn(
        `[refund-retry] ${order.orderId}: no real razorpayPaymentId (${paymentId || "empty"}) — skipping`
      );
      continue;
    }

    try {
      // Idempotency: if Razorpay already shows a refund (prior sweep or a manual
      // dashboard refund), reconcile rather than issue a second refund.
      const payment = await RazorpayService.getPaymentDetails(paymentId);
      const alreadyRefunded =
        (payment as { amount_refunded?: number })?.amount_refunded ?? 0;
      if (alreadyRefunded > 0) {
        order.mandateRefundStatus = "processed";
        if (!order.mandateRefundedAt) order.mandateRefundedAt = new Date();
        await order.save();
        res.alreadyRefunded += 1;
        serverLogger.info(
          `[refund-retry] ${order.orderId}: Razorpay already refunded ${alreadyRefunded} paise — reconciled to processed`
        );
        continue;
      }

      // Full refund of the mandate-validation payment (the whole ₹2). Omitting
      // the amount = full refund, which avoids any amount-mismatch edge cases.
      const refund = await RazorpayService.refundPayment(paymentId, undefined, {
        reason: "mandate_validation_refund_retry",
        orderId: order.orderId,
      });
      order.mandateRefundId = refund?.id;
      order.mandateRefundStatus = "processed";
      order.mandateRefundedAt = new Date();
      await order.save();
      res.refunded += 1;
      serverLogger.info(
        `[refund-retry] ${order.orderId}: mandate refund succeeded on retry (payment=${paymentId}, refund=${refund?.id})`
      );
    } catch (e) {
      res.stillFailing += 1;
      const msg = e instanceof Error ? e.message : String(e);
      serverLogger.error(
        `[refund-retry] ${order.orderId}: retry still failing (payment=${paymentId}): ${msg}`
      );
    }
  }

  return res;
}
