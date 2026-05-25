import { serverLogger } from "@/lib/server-logger";
import {
  razorpayClient,
  type RazorpayPayment,
  type RazorpayPaymentListResponse,
} from "@/lib/razorpay-client";

// Re-export the SDK record shapes so existing consumers
// (`import { RazorpayPayment } from "@/lib/razorpay-payments"`) keep
// working — definitions live in razorpay-client.ts now to avoid the
// circular import that would otherwise arise.
export type { RazorpayPayment, RazorpayPaymentListResponse };

export class RazorpayPaymentsService {
  /**
   * Fetch all payments from Razorpay
   */
  static async getAllPayments(
    limit: number = 100,
    skip: number = 0
  ): Promise<RazorpayPaymentListResponse> {
    try {
      return await razorpayClient.payments.all({
        count: limit,
        skip: skip,
      });
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
      return await razorpayClient.payments.all({
        count: limit,
        skip: skip,
        from: Math.floor(from.getTime() / 1000),
        to: Math.floor(to.getTime() / 1000),
      });
    } catch (error) {
      serverLogger.error(
        "Error fetching payments by date range from Razorpay:",
        error
      );
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
      orderId = orderId || (payment.notes.orderId as string | undefined);
      domainNames =
        (payment.notes.domainNames as string[] | undefined) ||
        (payment.notes.domainName ? [payment.notes.domainName as string] : []) ||
        ((payment.notes.domains as string[] | undefined) ?? []);
      customerName = payment.notes.customerName as string | undefined;
      customerEmail = payment.notes.customerEmail as string | undefined;
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
