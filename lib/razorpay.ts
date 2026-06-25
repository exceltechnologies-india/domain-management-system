import crypto from "crypto";
import { serverLogger } from "@/lib/server-logger";
import { razorpayClient, razorpay } from "@/lib/razorpay-client";
import type {
  RazorpayPaymentDetails,
  RazorpayOrderDetails,
  RazorpaySubscription,
  RazorpayRefund,
  RazorpayPlan,
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
  /**
   * Initializes a Razorpay intent/order for a specific transaction amount.
   * 
   * This guarantees the transaction amount is strictly converted to paise
   * and enforces Razorpay min/max limits before network dispatch.
   * 
   * @param {number} amount - The cart amount in fiat currency (e.g., INR)
   * @param {string} currency - The ISO currency code
   * @param {string} receipt - Unique local identifier representing the receipt
   * @param {Record<string, string>} notes - Arbitrary metadata appended to the order
   * @returns {Promise<PaymentOrder>} Razorpay fulfillment order details
   */
  static async createOrder(
    amount: number,
    currency: string = "INR",
    receipt: string,
    notes?: Record<string, string>
  ): Promise<PaymentOrder> {
    try {
      // Validate amount
      if (!amount || amount <= 0 || isNaN(amount)) {
        throw new Error(
          `Invalid amount: ${amount}. Amount must be a positive number.`
        );
      }

      // Ensure amount is an integer (Razorpay requirement)
      const amountInPaise = Math.round(amount * 100);

      // Validate amount is within Razorpay limits
      if (amountInPaise < 100) {
        throw new Error(`Amount too small: ₹${amount}. Minimum amount is ₹1.`);
      }

      if (amountInPaise > 100000000) {
        // ₹10,00,000
        throw new Error(
          `Amount too large: ₹${amount}. Maximum amount is ₹10,00,000.`
        );
      }

      serverLogger.info(
        `💰 [RAZORPAY] Creating order: ₹${amount} (${amountInPaise} paise)`
      );

      const options: {
        amount: number;
        currency: string;
        receipt: string;
        payment_capture: 1;
        notes?: Record<string, string>;
      } = {
        amount: amountInPaise,
        currency,
        receipt,
        payment_capture: 1,
      };

      if (notes) {
        options.notes = notes;
      }

      const order = await razorpayClient.orders.create(options);
      return order;
    } catch (error: unknown) {
      serverLogger.error("❌ [RAZORPAY] Order creation error:", error);
      const err = asRzpErr(error);

      // Handle specific Razorpay errors
      if (err.error) {
        const razorpayError = err.error;
        if (razorpayError.code === "BAD_REQUEST_ERROR") {
          if (razorpayError.description?.includes("amount")) {
            throw new Error(
              `Invalid amount format: ₹${amount}. Amount must be a valid number.`
            );
          }
          throw new Error(
            `Bad request: ${
              razorpayError.description || "Invalid payment request"
            }`
          );
        } else if (razorpayError.code === "GATEWAY_ERROR") {
          throw new Error(
            `Payment gateway error: ${
              razorpayError.description || "Gateway temporarily unavailable"
            }`
          );
        }
      }

      // Handle network/timeout errors
      if (err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT") {
        throw new Error(
          "Network error: Unable to connect to payment gateway. Please try again."
        );
      }

      // Generic error fallback
      throw new Error(
        `Failed to create payment order: ${err.message || "Unknown error"}`
      );
    }
  }

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

  /**
   * Create a subscription
   */
  static async createSubscription(
    planId: string,
    userId: string,
    domainName: string,
    customerNotify: boolean = true,
    totalCount: number = 100, // 100 cycles max for yearly
    trialDays?: number
  ): Promise<RazorpaySubscription> {
    try {
      const options: {
        plan_id: string;
        customer_notify: 0 | 1;
        total_count: number;
        quantity: number;
        addons: never[];
        notes: Record<string, string>;
        start_at?: number;
      } = {
        plan_id: planId,
        customer_notify: customerNotify ? 1 : 0,
        total_count: totalCount,
        quantity: 1,
        addons: [],
        notes: {
          source: "domain_dashboard",
          user_id: userId,
          domain_name: domainName,
        },
      };

      if (trialDays && trialDays > 0) {
        const startAt = Math.floor(Date.now() / 1000) + (trialDays * 24 * 60 * 60);
        options.start_at = startAt;
      }

      return await razorpayClient.subscriptions.create(options);
    } catch (error: unknown) {
      serverLogger.error("❌ [RAZORPAY] Subscription creation error:", error);
      const err = asRzpErr(error);
      throw new Error(
        `Failed to create subscription: ${err.error?.description || err.message}`
      );
    }
  }

  /**
   * Create a plan for subscriptions
   */
  static async createPlan(
    name: string,
    description: string,
    amount: number,
    period: 'monthly' | 'yearly',
    currency: string = 'INR'
  ): Promise<RazorpayPlan> {
    try {
      const amountInPaise = Math.round(amount * 100);

      const plan = await razorpayClient.plans.create({
        period: period === 'monthly' ? 'monthly' : 'yearly',
        interval: 1,
        item: {
          name,
          amount: amountInPaise,
          currency,
          description: description || `Subscription for ${name}`
        }
      });

      serverLogger.info(`✅ [RAZORPAY] Plan created: ${plan.id} for ${amount} ${period}`);
      return plan;
    } catch (error: unknown) {
      serverLogger.error("❌ [RAZORPAY] Plan creation error:", error);
      const err = asRzpErr(error);
      throw new Error(
        `Failed to create Razorpay plan: ${err.error?.description || err.message}`
      );
    }
  }

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

  /**
   * Create a Razorpay Customer for the Tokens recurring-payment flow.
   *
   * `fail_existing: 0` makes this idempotent — if a customer with the same
   * email/contact already exists, Razorpay returns that customer instead of
   * throwing a duplicate-key error. So repeated calls for the same user are
   * safe and return the same customer_id.
   */
  static async createCustomer(params: {
    name: string;
    email: string;
    contact: string;
    notes?: Record<string, string>;
  }): Promise<{ id: string; entity: string; name: string; email: string; contact: string }> {
    try {
      const customer = await razorpayClient.customers.create({
        name: params.name,
        email: params.email,
        contact: params.contact,
        fail_existing: 0,
        notes: params.notes,
      });
      serverLogger.info(`✅ [RAZORPAY] Customer ready: ${customer.id} (${params.email})`);
      return customer as { id: string; entity: string; name: string; email: string; contact: string };
    } catch (error: unknown) {
      serverLogger.error("❌ [RAZORPAY] Customer create error:", error);
      const err = asRzpErr(error);
      throw new Error(
        `Failed to create Razorpay customer: ${err.error?.description || err.message}`
      );
    }
  }

  /**
   * Create a recurring-authorization order (Customer-Initiated Transaction).
   *
   * This is the "₹2 validation transaction" that the customer authorizes on
   * Razorpay's checkout overlay. The validation amount (typically ₹2) is
   * debited at authorization; the mandate token returned in the resulting
   * `payment.captured` webhook is what we use for all future MIT charges.
   *
   * Caller must refund the validation amount via `refundPayment()` after
   * the token is captured — see webhook-handlers.handleRecurringTokenAuth.
   *
   * `validationAmountInPaise` defaults to 200 (₹2) which matches the
   * Google / Netflix industry-standard amount. Razorpay's minimum is 100 (₹1).
   *
   * `maxAmountInPaise` is the upper bound on any single future MIT debit.
   * For Cards, NPCI caps this at 1500000 (₹15,000) per debit — no waiver
   * path. For eMandate / NACH, the cap is 100000000 (₹10,00,000).
   *
   * `method` selects the payment-method category Razorpay shows on the overlay.
   *
   * `frequency` for Cards is 'as_presented' (merchant charges at will) or
   * 'monthly'. eMandate / NACH tokens omit frequency. UPI Autopay (post
   * 2026-07-08 activation): likely uses the card-token shape, verify with
   * Razorpay support.
   */
  static async createRecurringTokenOrder(params: {
    customerId: string;
    validationAmountInPaise?: number;
    maxAmountInPaise: number;
    method: 'card' | 'emandate' | 'upi' | 'nach' | 'netbanking';
    frequency?: 'as_presented' | 'monthly';
    expireAt?: number;
    receipt: string;
    notes?: Record<string, string>;
  }): Promise<PaymentOrder> {
    try {
      const validationAmount = params.validationAmountInPaise ?? 200;
      if (validationAmount < 100) {
        throw new Error(
          `Validation amount must be at least 100 paise (₹1); got ${validationAmount}`
        );
      }
      const expireAt = params.expireAt ?? Math.floor(Date.now() / 1000) + (10 * 365 * 24 * 60 * 60);

      // Token shape varies by method. Cards + UPI use the card-token shape;
      // eMandate / NACH use the eMandate shape with auth_type. We only type
      // the minimum subset the SDK accepts via RazorpayAuthorizationCreateRequestBody.
      const isCardLike = params.method === 'card' || params.method === 'upi';
      const tokenObj = isCardLike
        ? {
            max_amount: params.maxAmountInPaise,
            expire_at: expireAt,
            frequency: params.frequency ?? 'as_presented',
          }
        : {
            auth_type: params.method === 'nach' ? 'physical' : 'netbanking',
            max_amount: params.maxAmountInPaise,
            expire_at: expireAt,
          };

      serverLogger.info(
        `💰 [RAZORPAY] Creating recurring-token order: customer=${params.customerId} validationAmount=${validationAmount} maxAmount=${params.maxAmountInPaise} method=${params.method}`
      );

      const order = await razorpayClient.orders.create({
        amount: validationAmount,
        currency: 'INR',
        customer_id: params.customerId,
        payment_capture: true,
        method: params.method,
        receipt: params.receipt,
        notes: params.notes,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- token shape varies by method, SDK union
        token: tokenObj as any,
      });
      serverLogger.info(`✅ [RAZORPAY] Recurring-token order created: ${order.id}`);
      return order as unknown as PaymentOrder;
    } catch (error: unknown) {
      serverLogger.error("❌ [RAZORPAY] Recurring-token order create error:", error);
      const err = asRzpErr(error);
      throw new Error(
        `Failed to create recurring-token order: ${err.error?.description || err.message}`
      );
    }
  }

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
      throw new Error(
        `Failed to charge via token: ${err.error?.description || err.message}`
      );
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
   * allows — typically minutes for UPI, hours-to-days for cards.
   */
  static async refundPayment(
    paymentId: string,
    amountInPaise?: number,
    notes?: Record<string, string>
  ): Promise<RazorpayRefund> {
    try {
      const refundOptions: { amount?: number; speed?: 'optimum' | 'normal'; notes?: Record<string, string> } = {
        speed: 'optimum',
        notes,
      };
      if (typeof amountInPaise === 'number') refundOptions.amount = amountInPaise;

      const refund = await razorpayClient.payments.refund(paymentId, refundOptions);
      serverLogger.info(
        `✅ [RAZORPAY] Refund created: ${refund.id} for payment ${paymentId} (${amountInPaise ?? 'full'} paise)`
      );
      return refund as RazorpayRefund;
    } catch (error: unknown) {
      serverLogger.error("❌ [RAZORPAY] Refund error:", error);
      const err = asRzpErr(error);
      throw new Error(
        `Failed to refund payment ${paymentId}: ${err.error?.description || err.message}`
      );
    }
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

      return expectedSignature === signature;
    } catch (error) {
      serverLogger.error("Webhook signature verification error:", error);
      return false;
    }
  }
}
