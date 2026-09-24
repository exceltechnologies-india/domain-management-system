import { EmailService } from "@/lib/email";
import { WhatsAppService } from "@/lib/whatsapp";
import { serverLogger } from "@/lib/server-logger";
import type { IOrder } from "@/models/Order";
import type { IUser } from "@/models/User";
import type { CartItem, RazorpayPaymentDetails } from "@/lib/types";
import type { OrderDomain } from "@/lib/services/payment/provisioner";

export interface PostTasksContext {
  order: IOrder;
  user: IUser;
  orderDomains: OrderDomain[];
  finalSuccessfulDomains: string[];
  orderStatus: string;
}

/** Everything the invoice chokepoint (`createPrimaryInvoice`) needs. */
export interface InvoiceContext {
  order: IOrder;
  orderId: string;
  razorpay_payment_id: string;
  paymentDetails: RazorpayPaymentDetails;
  user: IUser;
  cartItems: CartItem[];
}

export interface InvoiceClaimOptions {
  /**
   * Lets an asynchronous, retried caller steal an abandoned claim older than
   * this. Synchronous callers omit it — see `claimOrderForPrimaryInvoice`.
   */
  staleClaimAfterMs?: number;
}

/**
 * Runs non-critical post-payment tasks in parallel:
 * admin notification and domain booking email.
 * All errors are caught internally — these must never fail the payment response.
 */
export async function runPostPaymentTasks(
  ctx: PostTasksContext
): Promise<void> {
  const { order, user, orderDomains, finalSuccessfulDomains, orderStatus } = ctx;

  const adminNotify = async () => {
    try {
      await EmailService.sendAdminNotification(
        process.env.ADMIN_EMAIL || "sales@anutech.in",
        "New Domain Order",
        `A new domain order has been placed by ${user.firstName} ${user.lastName} (${user.email})`,
        {
          orderId: order.orderId,
          invoiceNumber: order.invoiceNumber,
          customerName: `${user.firstName} ${user.lastName}`,
          customerEmail: user.email,
          amount: order.amount,
          currency: order.currency,
          successfulDomains: finalSuccessfulDomains,
          orderStatus: orderStatus,
        }
      );
    } catch (e) {
      serverLogger.error("❌ [PAYMENT-VERIFY] Admin notification error:", e);
    }
  };

  const domainBookingNotify = async () => {
    try {
      const domainItems = orderDomains.filter((d) => d.itemType !== "hosting");

      if (domainItems.length > 0) {
        await EmailService.sendDomainBookingStatusEmail(
          user.email,
          `${user.firstName} ${user.lastName}`,
          domainItems.map((d) => ({
            domainName: d.domainName,
            status: d.status,
            registrationPeriod: d.registrationPeriod,
            expiresAt: d.expiresAt,
          })),
          order.orderId
        );
        serverLogger.info(
          `📧 [PAYMENT-VERIFY] Domain booking status email sent to ${user.email}`
        );
      }
    } catch (e) {
      serverLogger.error("❌ [PAYMENT-VERIFY] Domain booking email error:", e);
    }
  };

  // WhatsApp payment confirmation — fires alongside the email when the
  // customer has a WhatsApp number on file (which they entered under a
  // "WhatsApp number for notifications" field = implicit opt-in). The
  // service self-gates on the master enable flag + token/phone-id
  // config, so this is a silent no-op when WhatsApp is off/unconfigured
  // — safe to always attempt. Best-effort: a WhatsApp failure never
  // affects the email path or the payment outcome.
  const whatsappNotify = async () => {
    try {
      if (!user.whatsappNumber || user.whatsappOptOut === true) return;
      const serviceName =
        finalSuccessfulDomains.length > 1
          ? `${finalSuccessfulDomains[0]} +${finalSuccessfulDomains.length - 1} more`
          : finalSuccessfulDomains[0] || "your order";
      await WhatsAppService.sendPaymentConfirmed(user.whatsappNumber, {
        amount: order.amount,
        currency: order.currency,
        serviceName,
      });
    } catch (e) {
      serverLogger.error("❌ [PAYMENT-VERIFY] WhatsApp payment-confirmed error:", e);
    }
  };

  await Promise.all([adminNotify(), domainBookingNotify(), whatsappNotify()]);
}
