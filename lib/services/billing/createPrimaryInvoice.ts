import type { IOrder } from "@/models/Order";
import type { IUser } from "@/models/User";
import { serverLogger } from "@/lib/server-logger";
import { getCompanyProfile } from "@/lib/billing/companyProfile";
import { computeGstBreakdown, placeOfSupply } from "@/lib/billing/gst";
import { allocateInvoiceNumber } from "@/lib/billing/invoiceNumber";
import {
  claimOrderForPrimaryInvoice,
  releasePrimaryInvoiceClaim,
  recordPrimaryInvoiceForOrder,
} from "@/lib/services/orders";
import type { InvoiceClaimOptions, InvoiceContext } from "@/lib/services/payment/post-tasks";

/**
 * What happened on this call.
 *  - 'primary' — our own GST engine minted a TI/... tax invoice
 *  - 'skipped' — nothing was issued (zero-amount/trial order, or a
 *                concurrent request already holds the claim)
 *
 * There is no other engine. Zoho Books was the fallback until it was removed
 * on 24 Sep 2026 by owner decision; a failure now throws instead.
 *
 * Callers holding an in-memory Order document MUST use this to sync the
 * issued number back onto that document before saving it — see the
 * webhook's payment.captured handler for why (the Order pre-save hook
 * mints a legacy invoiceNumber on the pending->completed transition when
 * the in-memory doc still looks un-invoiced, silently overwriting a real
 * tax-invoice number written to the DB by this function).
 */
export interface PrimaryInvoiceResult {
  invoiceId: string;
  invoiceNumber: string | null;
  provider: "primary" | "skipped";
}

/**
 * The primary GST engine's own attempt: claim -> compute -> allocate ->
 * persist. Returns null when a concurrent request already claimed/issued
 * this order's invoice (silent skip, not a failure — mirrors
 * the other claim-holders: a skip is not a failure).
 * Throws on any real failure; createPrimaryInvoice below lets it propagate.
 */
async function attemptCreatePrimaryInvoice(
  order: IOrder,
  user: IUser,
  claimOptions?: InvoiceClaimOptions
): Promise<{ invoiceNumber: string } | null> {
  const claimed = await claimOrderForPrimaryInvoice(order._id, claimOptions);
  if (!claimed) {
    serverLogger.info(
      `⏭️ [PrimaryInvoice] Order ${order.orderId} already claimed/issued. Skipping.`
    );
    return null;
  }

  try {
    const company = getCompanyProfile();
    if (!company.state) {
      // Fail loud HERE, not at PDF-render time (lib/billing/pdf.ts
      // deliberately tolerates a missing state) — GST math without a known
      // org state can't be trusted, so this must fail rather than silently
      // mis-compute CGST/SGST vs IGST.
      throw new Error(
        "COMPANY_STATE is not configured — cannot compute GST place of supply. Set COMPANY_STATE to the state our GSTIN is registered in."
      );
    }

    const customerState = user.address?.state;
    const breakdown = computeGstBreakdown(order.amount, company.state, customerState);
    // Allocation is the point of no return: the Counter increments
    // atomically regardless of whether the write below succeeds. A crash in
    // that narrow window leaves a documented gap in the TI/... series
    // (acceptable under GST rules with a note in the books; NOT a
    // silently-reused number, which would be the worse failure mode).
    const invoiceNumber = await allocateInvoiceNumber();

    await recordPrimaryInvoiceForOrder(order._id, {
      invoiceNumber,
      gstRate: breakdown.gstRate,
      taxableValue: breakdown.taxableValue,
      cgst: breakdown.cgst,
      sgst: breakdown.sgst,
      igst: breakdown.igst,
      placeOfSupply: placeOfSupply(customerState),
      customerGstin: user.gstNumber,
    });

    serverLogger.info(
      `✅ [PrimaryInvoice] Tax invoice ${invoiceNumber} issued for order ${order.orderId}`
    );
    return { invoiceNumber };
  } catch (err) {
    await releasePrimaryInvoiceClaim(order._id);
    throw err;
  }
}

/**
 * The single invoice chokepoint. Every paid order that is invoiced at all is
 * invoiced here, by our own GST engine — the TI/... number is the tax invoice
 * of record. There is no fallback engine and no switch: on failure this
 * THROWS, and the caller records it (`markInvoiceCreationFailed` + a
 * SystemLog row) so the order surfaces in admin integration-health and the
 * retry paths pick it up. A paid-but-uninvoiced order needing an operator is
 * the honest outcome; a silently second-series invoice is not.
 *
 * ZERO-AMOUNT INVOICE POLICY (operator decision 2026-06-30): ₹0 orders and
 * `hosting_trial` orders are NOT invoiced. A trial creates an audit-trail
 * Order with `amount: 0`; the first real tax invoice is issued when the
 * renewal flow charges the real amount. Compliant with GST (a tax invoice is
 * required only for taxable consideration > 0). See CLAUDE.md "Trial order
 * invoice policy".
 *
 * `invoiceId` in the returned pair has no external meaning — it is set to the
 * invoice number for callers that log it.
 *
 * `options.claimOptions.staleClaimAfterMs` is for asynchronous, retried
 * callers only (idempotency.ts, the issue-invoice worker, lib/invoice-retry,
 * the admin re-sync), so a crashed prior attempt's claim doesn't block them
 * forever. Synchronous call sites (both verify routes, renewal.ts, the
 * webhook) omit it: a concurrent in-flight claim there genuinely means another
 * request is issuing the invoice right now. Stealing can never re-issue a
 * COMPLETED invoice — the claim also filters on `invoiceProvider`.
 */
export async function createPrimaryInvoice(
  ctx: InvoiceContext,
  options: { claimOptions?: InvoiceClaimOptions } = {}
): Promise<PrimaryInvoiceResult> {
  const orderAmount = ctx.order?.amount;
  const orderType = ctx.order?.orderType;
  if (!orderAmount || orderAmount <= 0 || orderType === "hosting_trial") {
    serverLogger.info(
      `⏭️ [PrimaryInvoice] Skipping zero-amount/trial order ${ctx.orderId} ` +
      `(amount=${orderAmount}, orderType=${orderType}) — Trial order invoice policy.`
    );
    return { invoiceId: "", invoiceNumber: null, provider: "skipped" };
  }

  try {
    const result = await attemptCreatePrimaryInvoice(
      ctx.order,
      ctx.user,
      options.claimOptions
    );
    if (!result) {
      return { invoiceId: "", invoiceNumber: null, provider: "skipped" };
    }
    return {
      invoiceId: result.invoiceNumber,
      invoiceNumber: result.invoiceNumber,
      provider: "primary",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    serverLogger.error(
      `❌ [PrimaryInvoice] Engine failed for order ${ctx.orderId} — order is UNINVOICED pending retry/operator action: ${message}`
    );
    throw err;
  }
}
