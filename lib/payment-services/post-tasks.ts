import { EmailService } from "@/lib/email";
import { ZohoBooksService } from "@/lib/zohobooks";
import { serverLogger } from "@/lib/server-logger";
import Order from "@/models/Order";
import type { IOrder } from "@/models/Order";
import type { IUser } from "@/models/User";
import type { CartItem, RazorpayPaymentDetails, ZohoInvoice } from "@/lib/types";
import type { OrderDomain } from "@/lib/payment-services/provisioner";

export interface PostTasksContext {
  order: IOrder;
  user: IUser;
  orderDomains: OrderDomain[];
  finalSuccessfulDomains: string[];
  orderStatus: string;
}

export interface ZohoInvoiceContext {
  order: IOrder;
  orderId: string;
  razorpay_payment_id: string;
  paymentDetails: RazorpayPaymentDetails;
  user: IUser;
  cartItems: CartItem[];
}

/**
 * Creates a Zoho Books invoice synchronously.
 * Throws on failure — callers must handle and surface the error.
 * Returns the created invoice ID and Zoho invoice number.
 */
export async function createZohoInvoice(
  ctx: ZohoInvoiceContext
): Promise<{ invoiceId: string; invoiceNumber: string | null }> {
  const { order, orderId, razorpay_payment_id, paymentDetails, user, cartItems } = ctx;

  // Atomic claim: prevents duplicate creation if called concurrently
  const claimedOrder = await Order.findOneAndUpdate(
    { _id: order._id, zohoInvoiceId: { $exists: false } },
    { $set: { zohoInvoiceId: "pending_creation" } },
    { new: true }
  );

  if (!claimedOrder) {
    // Another call already claimed or completed the invoice
    serverLogger.info(
      `⏭️ [PAYMENT-VERIFY] Zoho invoice already claimed or exists for Order ${orderId}. Skipping.`
    );
    return { invoiceId: "", invoiceNumber: null };
  }

  const zohoService = ZohoBooksService.getInstance();
  let invoice: ZohoInvoice;
  try {
    invoice = await zohoService.createInvoice(
      {
        orderId,
        razorpayPaymentId: razorpay_payment_id,
        total: paymentDetails.amount,
      },
      user,
      cartItems.map((item) => ({
        ...item,
        periodUnit:
          item.periodUnit ||
          (item.itemType === "hosting"
            ? item.registrationPeriod === 10
              ? "minutes"
              : "months"
            : "years"),
      }))
    );
  } catch (err) {
    // Release the claim so a retry or the idempotency recovery can try again
    await Order.updateOne(
      { _id: order._id, zohoInvoiceId: "pending_creation" },
      { $unset: { zohoInvoiceId: "" } }
    );
    throw err;
  }

  if (!invoice?.invoice_id) {
    await Order.updateOne(
      { _id: order._id, zohoInvoiceId: "pending_creation" },
      { $unset: { zohoInvoiceId: "" } }
    );
    throw new Error(
      `Zoho invoice creation returned no invoice_id for Order ${orderId} — possible validation error (GST number, contact data, etc.)`
    );
  }

  try {
    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          zohoInvoiceId: invoice.invoice_id,
          invoiceNumber: invoice.invoice_number || undefined,
        },
      }
    );
  } catch (e: any) {
    // E11000 = unique-index conflict on invoiceNumber. Happens when Zoho's
    // idempotency search returned an existing invoice whose number is already
    // attributed to another local Order. Keep the local placeholder number
    // and attach the real zohoInvoiceId — View/Download still work.
    if (e?.code === 11000) {
      serverLogger.warn(
        `⚠️ [PAYMENT-VERIFY] Duplicate invoiceNumber ${invoice.invoice_number} for Order ${orderId}; storing zohoInvoiceId only.`
      );
      await Order.updateOne(
        { _id: order._id },
        { $set: { zohoInvoiceId: invoice.invoice_id } }
      );
    } else {
      throw e;
    }
  }

  serverLogger.info(
    `✅ [PAYMENT-VERIFY] Zoho Invoice created: ${invoice.invoice_id} (${invoice.invoice_number}) for Order ${orderId}`
  );

  return {
    invoiceId: invoice.invoice_id,
    invoiceNumber: invoice.invoice_number || null,
  };
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

  await Promise.all([adminNotify(), domainBookingNotify()]);
}
