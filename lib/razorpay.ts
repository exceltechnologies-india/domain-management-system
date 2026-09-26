import crypto from "crypto";
import { serverLogger } from "@/lib/server-logger";
import { safeEqual } from "./timing-safe";
import { razorpayClient, razorpay } from "@/lib/razorpay-client";
import type {
  RazorpayPaymentDetails,
  RazorpayOrderDetails,
  RazorpaySubscription,
  RazorpayRefund,
} from "@/lib/types";

interface RazorpaySdkError {
  code?: string;
  message?: string;
  error?: { code?: string; description?: string };
}

function asRzpErr(error: unknown): RazorpaySdkError {
  if (error && typeof error === "object") return error as RazorpaySdkError;
  return { message: String(error) };
}

export { razorpay };

export interface PaymentOrder {
  id: string;
  amount: number;
  currency: string;
  receipt: string;
  status: string;
  created_at: number;
}

export interface PaymentVerification {
  razorpay_order_id?: string;
  razorpay_subscription_id?: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

/**
 * Razorpay Payment Gateway Integration
 * 
 * Provides static methods for managing the lifecycle of Razorpay payments,
 * including order creation, signature verification, refunds, and subscriptions.
 * It serves as a unified abstraction layer over the official razorpay SDK.
 */

export class RazorpayService {
  // createOrder and createSubscription were DELETED on 25 Sep 2026: DMS takes
  // no payment on its own Razorpay account (owner decision 30 and round 3 —
  // every order is ResellerOS's). tests/unit/lib/no-dms-razorpay-payments.test.ts
  // fails if a payment-taking call comes back outside its allow-list.
  /**
   * Cryptographically verifies the webhook or frontend payload signature.
   * 
   * This is a critical security step that prevents tampering by validating
   * that the `razorpay_signature` corresponds to a SHA256 HMAC of the 
   * localized order parameters signed by the private secret.
   * 
   * @param {PaymentVerification} verification - The payload details from Razorpay client
   * @returns {boolean} True if the mathematical signature constraint matches
   */
  static verifyPayment(verification: PaymentVerification): boolean {
    try {
      const { razorpay_order_id, razorpay_subscription_id, razorpay_payment_id, razorpay_signature } =
        verification;

      let body = "";
      if (razorpay_order_id) {
        body = razorpay_order_id + "|" + razorpay_payment_id;
      } else if (razorpay_subscription_id) {
        body = razorpay_payment_id + "|" + razorpay_subscription_id;
      } else {
        return false;
      }

      const expectedSignature = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET!)
        .update(body.toString())
        .digest("hex");

      const isValid = crypto.timingSafeEqual(
        Buffer.from(expectedSignature, 'hex'),
        Buffer.from(razorpay_signature, 'hex')
      );
      return isValid;
    } catch (error) {
      serverLogger.error("Payment verification error:", error);
      return false;
    }
  }

  /**
   * Get payment details
   */
  static async getPaymentDetails(paymentId: string): Promise<RazorpayPaymentDetails> {
    try {
      return await razorpayClient.payments.fetch(paymentId);
    } catch (error) {
      serverLogger.error("Razorpay payment fetch error:", error);
      throw new Error("Failed to fetch payment details");
    }
  }

  /**
   * Refund payment
   */
  /**
   * Get order details
   */
  static async getOrderDetails(orderId: string): Promise<RazorpayOrderDetails> {
    try {
      return await razorpayClient.orders.fetch(orderId);
    } catch (error) {
      serverLogger.error("Razorpay order fetch error:", error);
      throw new Error("Failed to fetch order details");
    }
  }

  // createPlan deleted 26 Sep 2026 (owner: "Stop creating plans"). Its one
  // caller, the admin package edit, no longer makes Razorpay plans; the
  // no-dms-razorpay-payments guard refuses `plans.create` coming back.

  /**
   * Cancel a subscription
   */
  static async cancelSubscription(subscriptionId: string): Promise<RazorpaySubscription> {
    try {
      return await razorpayClient.subscriptions.cancel(subscriptionId);
    } catch (error: unknown) {
      serverLogger.error("❌ [RAZORPAY] Subscription cancellation error:", error);
      const err = asRzpErr(error);
      throw new Error(
        `Failed to cancel subscription: ${err.error?.description || err.message}`
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Tokens-flow methods (Google / Netflix / Spotify ₹2-charge-and-reverse
  // pattern). Used by the Tokens migration flow when `HOSTING_MANDATE_FLOW`
  // is set to `tokens`. See docs/razorpay-tokens-migration.md for the
  // architecture. These methods coexist with the Subscriptions-API methods
  // above so the feature flag can route between flows without code duplication.
  // ──────────────────────────────────────────────────────────────────────────

  // createCustomer and createRecurringTokenOrder were DELETED on 26 Sep 2026
  // (owner: "Delete dead DMS code"): they set up a NEW Tokens mandate at
  // signup, and nothing has called them since create-order was removed. Only
  // chargeViaToken below remains — the gated charger for EXISTING tokens.

  /**
   * Charge a customer via a stored mandate token (Merchant-Initiated Transaction).
   *
   * Used by the recurring-charge cron after the initial CIT auth has stored
   * a token on the Hosting record. No customer involvement — the mandate
   * permits us to debit any amount up to the token's `max_amount`.
   *
   * Two-step at the Razorpay API level: (1) create an Order for the MIT
   * amount, (2) create a recurring Payment against that order using the
   * token. Both happen inside this method.
   */
  static async chargeViaToken(params: {
    customerId: string;
    tokenId: string;
    amountInRupees: number;
    email: string;
    contact: string;
    receipt: string;
    description?: string;
    notes?: Record<string, string>;
  }): Promise<{ orderId: string; paymentId: string; amount: number }> {
    try {
      const amountInPaise = Math.round(params.amountInRupees * 100);
      if (amountInPaise < 100) {
        throw new Error(
          `MIT charge amount too small: ₹${params.amountInRupees} (${amountInPaise} paise); minimum ₹1.`
        );
      }

      serverLogger.info(
        `💰 [RAZORPAY] MIT charge starting: customer=${params.customerId} token=${params.tokenId} amount=₹${params.amountInRupees}`
      );

      // Step 1: order for the MIT amount
      const order = await razorpayClient.orders.create({
        amount: amountInPaise,
        currency: 'INR',
        customer_id: params.customerId,
        payment_capture: true,
        receipt: params.receipt,
        notes: params.notes,
      });

      // Step 2: recurring payment using the stored token
      const payment = await razorpayClient.payments.createRecurringPayment({
        email: params.email,
        contact: params.contact,
        amount: amountInPaise,
        currency: 'INR',
        order_id: order.id,
        customer_id: params.customerId,
        token: params.tokenId,
        recurring: true,
        notes: params.notes as { [key: string]: string },
        description: params.description ?? `Recurring charge: ₹${params.amountInRupees}`,
      });

      // `createRecurringPayment` returns a Payment-like object; the SDK type
      // says `{razorpay_payment_id, razorpay_order_id, razorpay_signature}`.
      // But field naming varies in practice — read defensively.
      const paymentObj = payment as unknown as {
        razorpay_payment_id?: string;
        id?: string;
      };
      const paymentId = paymentObj.razorpay_payment_id ?? paymentObj.id ?? '';
      if (!paymentId) {
        throw new Error('createRecurringPayment returned no payment id');
      }
      serverLogger.info(
        `✅ [RAZORPAY] MIT charge initiated: order=${order.id} payment=${paymentId} amount=₹${params.amountInRupees}`
      );
      return { orderId: order.id, paymentId, amount: amountInPaise };
    } catch (error: unknown) {
      serverLogger.error("❌ [RAZORPAY] MIT charge error:", error);
      const err = asRzpErr(error);
      // Classify the failure so the caller can distinguish a genuine card/bank
      // DECLINE (the charge reached the network and was refused → downstream
      // suspend is legitimate) from a SOFT/INFRA failure (the charge NEVER
      // completed: 404 endpoint/config, 408 timeout, 429 rate-limit, 5xx
      // server, or a transport error with no HTTP status). A customer must
      // NEVER be suspended for our / Razorpay's infra problem, so those are
      // flagged `retriable:true` = "retry later, don't suspend". Default to
      // retriable unless it's clearly a request-level decline (a 4xx that
      // isn't one of the infra codes). The SDK attaches `statusCode`
      // (node_modules/razorpay/dist/api.js).
      const statusCode = (error as { statusCode?: number })?.statusCode;
      const retriable =
        typeof statusCode !== "number" || // network / timeout / no response
        statusCode === 404 ||
        statusCode === 408 ||
        statusCode === 429 ||
        statusCode >= 500;
      throw Object.assign(
        new Error(`Failed to charge via token: ${err.error?.description || err.message}`),
        { retriable, statusCode }
      );
    }
  }

  /**
   * Revoke (delete) a stored recurring-payment token so the mandate is torn
   * down cleanly — used when a Tokens-flow trial is cancelled. After this the
   * token can no longer be used for any merchant-initiated charge.
   *
   * Best-effort by design: the caller (cancel-trial) has already terminated
   * the hosting + set autoRenew=false + billingType=manual, so the
   * recurring-charge cron won't fire regardless. Revoking the token is the
   * clean teardown on top of that — a failure here must NOT block cancellation.
   * Returns true on success, false on failure (already-deleted / not-found /
   * API error), so the caller can decide whether to still clear the local id.
   */
  static async revokeToken(customerId: string, tokenId: string): Promise<boolean> {
    try {
      // Razorpay Node SDK: customers.deleteToken(customerId, tokenId).
      await (razorpayClient.customers as unknown as {
        deleteToken: (customerId: string, tokenId: string) => Promise<unknown>;
      }).deleteToken(customerId, tokenId);
      serverLogger.info(
        `🔒 [RAZORPAY] Token revoked: customer=${customerId} token=${tokenId}`
      );
      return true;
    } catch (error: unknown) {
      const err = asRzpErr(error);
      serverLogger.error(
        `⚠️ [RAZORPAY] Token revoke failed (customer=${customerId} token=${tokenId}): ${err.error?.description || err.message}`
      );
      return false;
    }
  }

  /**
   * Refund a payment. Used to reverse the ₹2 mandate-validation charge
   * immediately after the token is captured (the "and reverse" half of the
   * "₹2-charge-and-reverse" pattern).
   *
   * `amountInPaise` is optional; if omitted, refunds the full payment amount.
   *
   * `speed: 'optimum'` returns money to the customer as fast as the rail
   * allows — typically minutes for UPI, hours-to-days for cards. BUT
   * `optimum` requires the "Instant Refunds" feature to be enabled on the
   * Razorpay account; when it isn't, Razorpay rejects the call with a 400
   * "invalid request sent" (BAD_REQUEST_ERROR). That failure silently broke
   * the tokens-trial ₹2 mandate reversal — the webhook caught + swallowed it
   * so provisioning wasn't blocked, and the ₹2 was never returned to the
   * customer. So we now attempt `optimum` first and, on a request-shape
   * rejection, fall back to `normal` (standard 5-7 day refund, always
   * available) rather than letting the reversal fail outright.
   */
  static async refundPayment(
    paymentId: string,
    amountInPaise?: number,
    notes?: Record<string, string>
  ): Promise<RazorpayRefund> {
    const speeds: Array<'optimum' | 'normal'> = ['optimum', 'normal'];
    let lastError: unknown;
    for (const speed of speeds) {
      try {
        const refundOptions: { amount?: number; speed?: 'optimum' | 'normal'; notes?: Record<string, string> } = {
          speed,
          notes,
        };
        if (typeof amountInPaise === 'number') refundOptions.amount = amountInPaise;

        const refund = await razorpayClient.payments.refund(paymentId, refundOptions);
        serverLogger.info(
          `✅ [RAZORPAY] Refund created: ${refund.id} for payment ${paymentId} (${amountInPaise ?? 'full'} paise, speed=${speed})`
        );
        return refund as RazorpayRefund;
      } catch (error: unknown) {
        lastError = error;
        const err = asRzpErr(error);
        // Only fall back on a request-shape rejection (e.g. Instant Refunds
        // not enabled). Genuine failures (already refunded, insufficient
        // balance, etc.) will fail the same way on 'normal', so the loop
        // still surfaces them via the final throw below.
        if (speed !== speeds[speeds.length - 1]) {
          serverLogger.warn(
            `⚠️ [RAZORPAY] Refund speed=${speed} rejected for ${paymentId} (${err.error?.description || err.message}) — retrying with 'normal'`
          );
          continue;
        }
        serverLogger.error("❌ [RAZORPAY] Refund error:", error);
      }
    }
    const err = asRzpErr(lastError);
    throw new Error(
      `Failed to refund payment ${paymentId}: ${err.error?.description || err.message}`
    );
  }

  /**
   * Verify Webhook Signature
   */
  static verifyWebhookSignature(
    body: string,
    signature: string,
    secret: string
  ): boolean {
    try {
      const expectedSignature = crypto
        .createHmac("sha256", secret)
        .update(body)
        .digest("hex");

      /* Constant-time. `===` returns at the first differing byte, and this
         signature arrives on an unauthenticated request from the internet.
         See lib/timing-safe.ts for why it is fixed even though it is not a
         practical break: the repository is public, so the comparison and the
         HMAC construction beside it are readable rather than guessable. */
      return safeEqual(expectedSignature, signature);
    } catch (error) {
      serverLogger.error("Webhook signature verification error:", error);
      return false;
    }
  }
}
