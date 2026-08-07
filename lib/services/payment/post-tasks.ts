import { EmailService } from "@/lib/email";
import { WhatsAppService } from "@/lib/whatsapp";
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
  claimOrderForBillingInvoice,
  recordBillingInvoiceForOrder,
  releaseBillingInvoiceClaim,
} from "@/lib/services/orders";
import { inferPeriodUnit } from "@/lib/billing";
import { createBillingInvoice } from "@/lib/integrations/billing-customer";
import { setUserBillingCustomerId } from "@/lib/services/users";
import { findHostingByOrderId } from "@/lib/services/hostings";

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
 * Single attempt at creating a Billing Panel (ResellerOS) invoice for an
 * already-paid order — the Zoho replacement. Claims the order the same way
 * the Zoho path does, so the two can never double-invoice the same order.
 *
 * Line items are collapsed into one combined line rather than mirroring
 * Zoho's per-domain breakdown: Billing's invoice RPC adds 18% GST on top of
 * the rate given, whereas `item.price` here is already GST-inclusive (what
 * Razorpay actually charged) — backing that out per-line would compound
 * rounding across items. One line at `order.amount / 1.18` reproduces the
 * original charged total accurately; per-item itemization can be added
 * later if the invoice needs to show a full breakdown.
 */
async function attemptCreateBillingInvoice(
  ctx: ZohoInvoiceContext
): Promise<{ invoiceId: string; invoiceNumber: string | null }> {
  const { order, orderId, razorpay_payment_id, paymentDetails, user } = ctx;

  const claimedOrder = await claimOrderForBillingInvoice(order._id);
  if (!claimedOrder) {
    serverLogger.info(
      `⏭️ [PAYMENT-VERIFY] Billing invoice already claimed or exists for Order ${orderId}. Skipping.`
    );
    return { invoiceId: "", invoiceNumber: null };
  }

  try {
    const totalInclusive = paymentDetails.amount;
    const rateExclusive = Math.round((totalInclusive / 1.18) * 100) / 100;

    // Stage 1: one renewal-tracking item per domain/hosting line on the
    // order, so Billing's cron can pick each up individually later — this
    // is separate from (and more granular than) the single combined
    // invoice line above. Hosting items also carry their DirectAdmin
    // username as externalRef — without it, Billing can decide a hosting
    // account is due for suspension but has no way to tell Customer Panel
    // WHICH account to act on.
    const renewalItems = await Promise.all(
      (order.domains ?? [])
        .filter((d) => d.expiresAt)
        .map(async (d) => {
          const itemType = (d.itemType ?? "domain") as "domain" | "hosting";
          const domainName = d.linkedDomain || d.domainName;
          let externalRef: string | undefined;
          if (itemType === "hosting") {
            const hosting = await findHostingByOrderId(orderId, { domainName });
            externalRef = hosting?.directAdminUsername;
          }
          return {
            itemType,
            domainName,
            renewalDate: new Date(d.expiresAt as Date).toISOString().slice(0, 10),
            amount: d.price ?? 0,
            ...(externalRef ? { externalRef } : {}),
          };
        })
    );

    const result = await createBillingInvoice({
      email: user.email,
      name: `${user.firstName} ${user.lastName}`.trim(),
      lineItems: [
        {
          description: `Order ${orderId} — domain/hosting purchase`,
          qty: 1,
          rate: rateExclusive,
        },
      ],
      amount: totalInclusive,
      razorpayPaymentId: razorpay_payment_id,
      renewalItems: renewalItems.length > 0 ? renewalItems : undefined,
    });

    await recordBillingInvoiceForOrder(order._id, {
      invoiceId: result.invoiceId,
      invoiceNumber: result.invoiceNumber,
      pdfUrl: result.pdfUrl,
    });
    if (result.billingCustomerId && !user.billingCustomerId) {
      await setUserBillingCustomerId(String(user._id), result.billingCustomerId);
    }

    serverLogger.info(
      `✅ [PAYMENT-VERIFY] Billing invoice created: ${result.invoiceId} (${result.invoiceNumber}) for Order ${orderId}`
    );
    return { invoiceId: result.invoiceId, invoiceNumber: result.invoiceNumber };
  } catch (err) {
    await releaseBillingInvoiceClaim(order._id);
    throw err;
  }
}

/**
 * Creates a Billing Panel invoice synchronously with the same outer-retry
 * shape as {@link createZohoInvoice}, and the same zero-amount/trial skip.
 */
export async function createBillingInvoiceForOrder(
  ctx: ZohoInvoiceContext,
  options: { maxAttempts?: number; retryDelayMs?: number } = {}
): Promise<{ invoiceId: string; invoiceNumber: string | null }> {
  const orderAmount = ctx.order?.amount;
  const orderType = ctx.order?.orderType;
  if (!orderAmount || orderAmount <= 0 || orderType === "hosting_trial") {
    serverLogger.info(
      `⏭️ [BillingInvoice] Skipping zero-amount/trial order ${ctx.orderId} (amount=${orderAmount}, orderType=${orderType}).`
    );
    return { invoiceId: "", invoiceNumber: null };
  }

  const maxAttempts = options.maxAttempts ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 1500;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await attemptCreateBillingInvoice(ctx);
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        const msg = err instanceof Error ? err.message : String(err);
        serverLogger.warn(
          `[BillingInvoice] Attempt ${attempt}/${maxAttempts} failed for order ${ctx.orderId}: ${msg} — retrying in ${retryDelayMs}ms`
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
