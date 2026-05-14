import Razorpay from "razorpay";
import { serverLogger } from "@/lib/server-logger";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

export interface RazorpayPayment {
  id: string;
  entity: string;
  amount: number;
  currency: string;
  status: string;
  method: string;
  description?: string;
  amount_refunded: number;
  refund_status?: string;
  captured: boolean;
  email: string;
  contact?: string;
  notes: Record<string, any>;
  fee?: number;
  tax?: number;
  error_code?: string;
  error_description?: string;
  error_source?: string;
  error_step?: string;
  error_reason?: string;
  acquirer_data?: Record<string, any>;
  created_at: number;
  updated_at: number;
}

export interface RazorpayPaymentListResponse {
  entity: string;
  count: number;
  items: RazorpayPayment[];
}

export class RazorpayPaymentsService {
  /**
   * Fetch all payments from Razorpay
   */
  static async getAllPayments(
    limit: number = 100,
    skip: number = 0
  ): Promise<RazorpayPaymentListResponse> {
    try {
      const response = await razorpay.payments.all({
        count: limit,
        skip: skip,
      });
      return response as unknown as RazorpayPaymentListResponse;
    } catch (error) {
      serverLogger.error("Error fetching payments from Razorpay:", error);
      throw error;
    }
  }

  /**
   * Fetch payments by date range
   */
  static async getPaymentsByDateRange(
    from: Date,
    to: Date,
    limit: number = 100,
    skip: number = 0
  ): Promise<RazorpayPaymentListResponse> {
    try {
      const response = await razorpay.payments.all({
        count: limit,
        skip: skip,
        from: Math.floor(from.getTime() / 1000),
        to: Math.floor(to.getTime() / 1000),
      });
      return response as unknown as RazorpayPaymentListResponse;
    } catch (error) {
      serverLogger.error(
        "Error fetching payments by date range from Razorpay:",
        error
      );
      throw error;
    }
  }

  /**
   * Fetch a specific payment by ID
   */
  static async getPaymentById(paymentId: string): Promise<RazorpayPayment> {
    try {
      const response = await razorpay.payments.fetch(paymentId);
      return response as unknown as RazorpayPayment;
    } catch (error) {
      serverLogger.error("Error fetching payment from Razorpay:", error);
      throw error;
    }
  }

  /**
   * Filter payments that are related to domain purchases
   * This filters based on our order ID pattern, description, and includes failed payments
   */
  static filterDomainPayments(payments: RazorpayPayment[]): RazorpayPayment[] {
    return payments.filter((payment) => {
      // Check if payment description contains our order ID pattern
      const hasOrderId = payment.description?.includes("ord_") || false;

      // Check if payment notes contain domain-related information
      const hasDomainNotes =
        payment.notes &&
        (payment.notes.domainName ||
          payment.notes.orderId ||
          payment.notes.domain ||
          payment.notes.domains);

      // Check if payment amount is reasonable for domain purchase (₹100 - ₹10000)
      // Expanded range to include more domain pricing scenarios
      const isReasonableAmount =
        payment.amount >= 10000 && payment.amount <= 1000000; // Amount in paise

      // Include failed payments that might be domain-related
      const isFailedDomainPayment =
        payment.status === "failed" &&
        (hasOrderId || hasDomainNotes || isReasonableAmount);

      // Include all payments that match our domain criteria OR are failed payments with domain indicators
      return (
        hasOrderId ||
        hasDomainNotes ||
        isReasonableAmount ||
        isFailedDomainPayment
      );
    });
  }

  /**
   * Get payment details with domain information
   */
  static async getDomainPaymentDetails(payment: RazorpayPayment): Promise<{
    payment: RazorpayPayment;
    orderId?: string;
    domainNames?: string[];
    customerName?: string;
    customerEmail?: string;
  }> {
    let orderId: string | undefined;
    let domainNames: string[] = [];
    let customerName: string | undefined;
    let customerEmail: string | undefined;

    // Extract order ID from description or notes
    if (payment.description?.includes("ord_")) {
      const match = payment.description.match(/ord_\d+_\w+/);
      orderId = match ? match[0] : undefined;
    }

    if (payment.notes) {
      orderId = orderId || payment.notes.orderId;
      domainNames =
        payment.notes.domainNames ||
        (payment.notes.domainName ? [payment.notes.domainName] : []) ||
        (payment.notes.domains ? payment.notes.domains : []);
      customerName = payment.notes.customerName;
      customerEmail = payment.notes.customerEmail;
    }

    // Use payment email if no customer email found
    customerEmail = customerEmail || payment.email;

    return {
      payment,
      orderId,
      domainNames,
      customerName,
      customerEmail,
    };
  }
}
