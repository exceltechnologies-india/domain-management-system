import { EmailService } from "@/lib/email";
import { ZohoBooksService } from "@/lib/zohobooks";
import { serverLogger } from "@/lib/server-logger";
import type { IOrder } from "@/models/Order";
import type { IUser } from "@/models/User";
import type { CartItem, RazorpayPaymentDetails, ZohoInvoice } from "@/lib/types";
import type { OrderDomain } from "@/lib/services/payment/provisioner";
import {
  claimOrderForZohoInvoice,
  recordZohoInvoiceForOrder,
  releaseZohoInvoiceClaim,
} from "@/lib/services/orders";
import { inferPeriodUnit } from "@/lib/billing";

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
 * Single attempt at creating a Zoho Books invoice. Claims the order,
 * issues the Zoho call, and on any failure releases the claim and rethrows.
 * The `_idempotentRetry` inside zohoService.createInvoice handles transient
 * 5xx/429/network errors at the HTTP layer; the outer retry in
 * `createZohoInvoice` covers cold-start races, token-refresh blips, and any
 * other case where re-running the whole flow (re-claim + re-fetch contact +
 * re-issue) is the right move.
 */
async function attemptCreateZohoInvoice(
  ctx: ZohoInvoiceContext
): Promise<{ invoiceId: string; invoiceNumber: string | null }> {
  const { order, orderId, razorpay_payment_id, paymentDetails, user, cartItems } = ctx;

  const claimedOrder = await claimOrderForZohoInvoice(order._id);
  if (!claimedOrder) {
    serverLogger.info(
      `⏭️ [PAYMENT-VERIFY] Zoho invoice already claimed or exists for Order ${orderId}. Skipping.`
    );
    return { invoiceId: "", invoiceNumber: null };
  }

  const zohoService = ZohoBooksService.getInstance();
  let invoice: ZohoInvoice | null;
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
        periodUnit: inferPeriodUnit(item),
      }))
    );
  } catch (err) {
    await releaseZohoInvoiceClaim(order._id);
    throw err;
  }

  if (!invoice?.invoice_id) {
    await releaseZohoInvoiceClaim(order._id);
    throw new Error(
      `Zoho invoice creation returned no invoice_id for Order ${orderId} — possible validation error (GST number, contact data, etc.)`
    );
  }

  await recordZohoInvoiceForOrder(order._id, {
    invoiceId: invoice.invoice_id,
    invoiceNumber: invoice.invoice_number || undefined,
  });

  serverLogger.info(
    `✅ [PAYMENT-VERIFY] Zoho Invoice created: ${invoice.invoice_id} (${invoice.invoice_number}) for Order ${orderId}`
  );

  return {
    invoiceId: invoice.invoice_id,
    invoiceNumber: invoice.invoice_number || null,
  };
}

/**
 * Creates a Zoho Books invoice synchronously with an outer retry layer.
 * Two attempts by default with a 1.5s delay between them — handles the
 * cold-start window and short Zoho hiccups so the user's first payment
 * usually lands an invoice without needing the background self-heal.
 * Throws on final failure — callers must handle and surface the error.
 *
 * ZERO-AMOUNT INVOICE POLICY (operator decision 2026-06-30): we
 * intentionally do NOT generate Zoho invoices for ₹0 orders. Trial
 * signups (15-day free trial under Manual or Tokens flow) create an
 * Order row with `amount: 0` + `orderType: 'hosting_trial'` purely as
 * audit-trail; the customer's first real tax invoice is issued at day
 * 15+ when the renewal flow charges the actual yearly amount. This is
 * compliant with Indian GST (tax invoice is required only for taxable
 * consideration > 0) AND matches industry practice (AWS / Netflix /
 * Spotify / GoDaddy all issue the first invoice at first real charge,
 * not at trial signup). The guard fires on amount<=0 OR explicit
 * trial-order types to defend against any future caller that hands
 * us a ₹0 context. See CLAUDE.md "Trial order invoice policy" + the
 * `project_trial_no_invoice` auto-memory entry.
 */
export async function createZohoInvoice(
  ctx: ZohoInvoiceContext,
  options: { maxAttempts?: number; retryDelayMs?: number } = {}
): Promise<{ invoiceId: string; invoiceNumber: string | null }> {
  const orderAmount = ctx.order?.amount;
  const orderType = ctx.order?.orderType;
  if (!orderAmount || orderAmount <= 0 || orderType === "hosting_trial") {
    serverLogger.info(
      `⏭️ [ZohoInvoice] Skipping zero-amount/trial order ${ctx.orderId} ` +
      `(amount=${orderAmount}, orderType=${orderType}). ` +
      `Invoice will be issued on the first real charge — see Trial order invoice policy.`
    );
    return { invoiceId: "", invoiceNumber: null };
  }

  const maxAttempts = options.maxAttempts ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 1500;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await attemptCreateZohoInvoice(ctx);
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        const msg = err instanceof Error ? err.message : String(err);
        serverLogger.warn(
          `[ZohoInvoice] Attempt ${attempt}/${maxAttempts} failed for order ${ctx.orderId}: ${msg} — retrying in ${retryDelayMs}ms`
        );
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
  }
  throw lastError;
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
