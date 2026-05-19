import Razorpay from "razorpay";
import crypto from "crypto";
import { serverLogger } from "@/lib/server-logger";
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

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  throw new Error("Razorpay configuration is missing");
}

export const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});

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

      const order = await razorpay.orders.create(options);
      return order as PaymentOrder;
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
        .createHmac("sha256", RAZORPAY_KEY_SECRET!)
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
      const payment = await razorpay.payments.fetch(paymentId);
      return payment as unknown as RazorpayPaymentDetails;
    } catch (error) {
      serverLogger.error("Razorpay payment fetch error:", error);
      throw new Error("Failed to fetch payment details");
    }
  }

  /**
   * Refund payment
   */
  static async refundPayment(paymentId: string, amount?: number): Promise<RazorpayRefund> {
    try {
      const refundOptions: { payment_id: string; amount?: number } = {
        payment_id: paymentId,
      };

      if (amount) {
        refundOptions.amount = amount * 100;
      }

      const refund = await razorpay.payments.refund(paymentId, refundOptions);
      return refund as unknown as RazorpayRefund;
    } catch (error) {
      serverLogger.error("Razorpay refund error:", error);
      throw new Error("Failed to process refund");
    }
  }

  /**
   * Get order details
   */
  static async getOrderDetails(orderId: string): Promise<RazorpayOrderDetails> {
    try {
      const order = await razorpay.orders.fetch(orderId);
      return order as unknown as RazorpayOrderDetails;
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

      const subscription = await razorpay.subscriptions.create(options);
      return subscription as unknown as RazorpaySubscription;
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

      const plan = await razorpay.plans.create({
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
      return plan as unknown as RazorpayPlan;
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
      const subscription = await razorpay.subscriptions.cancel(subscriptionId);
      return subscription as unknown as RazorpaySubscription;
    } catch (error: unknown) {
      serverLogger.error("❌ [RAZORPAY] Subscription cancellation error:", error);
      const err = asRzpErr(error);
      throw new Error(
        `Failed to cancel subscription: ${err.error?.description || err.message}`
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
