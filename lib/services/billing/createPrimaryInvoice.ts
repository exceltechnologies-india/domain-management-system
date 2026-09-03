import type { IOrder } from "@/models/Order";
import type { IUser } from "@/models/User";
import { serverLogger } from "@/lib/server-logger";
import { isZohoInvoiceFallbackEnabled } from "@/lib/zoho-fallback-flag";
import { getCompanyProfile } from "@/lib/billing/companyProfile";
import { computeGstBreakdown, placeOfSupply } from "@/lib/billing/gst";
import { allocateInvoiceNumber } from "@/lib/billing/invoiceNumber";
import {
  claimOrderForPrimaryInvoice,
  releasePrimaryInvoiceClaim,
  recordPrimaryInvoiceForOrder,
} from "@/lib/services/orders";
import { createZohoInvoice, type ZohoClaimOptions, type ZohoInvoiceContext } from "@/lib/services/payment/post-tasks";

/**
 * Which engine actually issued the invoice on this call.
 *  - 'primary' — our own GST engine minted a TI/... tax invoice
 *  - 'zoho'    — the fallback issued it (or the flag is off)
 *  - 'skipped' — nothing was issued (zero-amount/trial order, or a
 *                concurrent request already holds the claim)
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
  provider: "primary" | "zoho" | "skipped";
}

/**
 * The primary GST engine's own attempt: claim -> compute -> allocate ->
 * persist. Returns null when a concurrent request already claimed/issued
 * this order's invoice (silent skip, not a failure — mirrors
 * attemptCreateZohoInvoice's "already claimed" skip in post-tasks.ts).
 * Throws on any real failure so the caller (createPrimaryInvoice below)
 * falls back to Zoho.
 */
async function attemptCreatePrimaryInvoice(
  order: IOrder,
  user: IUser,
  claimOptions?: ZohoClaimOptions
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
      // org state can't be trusted, so this must fall back to Zoho instead
      // of silently mis-computing CGST/SGST vs IGST.
      throw new Error(
        "ZOHO_ORG_STATE is not configured — cannot compute GST place of supply for the primary engine"
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
 * Drop-in replacement for `createZohoInvoice` (same context shape, same
 * `{invoiceId, invoiceNumber}` return contract) that call sites can swap to
 * directly. Behavior:
 *  - The primary GST engine ALWAYS runs. It is permanent and ungated as of
 *    2026-09-03 — our `TI/...` number is the tax invoice of record. There is
 *    no switch that turns it off.
 *  - On ANY failure (thrown error), behaviour depends on
 *    `ZOHO_INVOICE_FALLBACK_ENABLED` (default ON): the fallback issues a
 *    Zoho invoice so a customer's payment never goes un-invoiced because our
 *    engine hit a bug. With the fallback explicitly disabled, the error is
 *    rethrown for the caller to record and surface instead — see
 *    lib/zoho-fallback-flag.ts for that trade-off.
 *
 * `invoiceId` in the returned pair has no meaning for a primary invoice
 * (there's no external gateway id) — set to the same value as
 * `invoiceNumber` for callers that log it, none of which currently branch
 * on its value.
 *
 * `options.claimOptions` is forwarded to BOTH engines: the full object
 * (`allowNull`/`allowFailed`/`staleClaimAfterMs`) to the Zoho path, and
 * `staleClaimAfterMs` alone to the primary path — the only one of the three
 * that has a primary-claim equivalent. Recovery callers (idempotency.ts) and
 * asynchronous, queue-retried callers (the sync-zoho-invoice Cloud Tasks
 * worker) pass it so a crashed prior attempt's claim doesn't block them
 * forever.
 *
 * Synchronous call sites (both verify routes, renewal.ts, the webhook
 * handler) deliberately omit it: they run inside one request, so a
 * concurrent in-flight claim genuinely means another request is issuing the
 * invoice right now and skipping is correct. Stealing there would risk two
 * engines issuing for one payment. Note that stealing can never re-issue a
 * COMPLETED invoice under either engine — both claims also filter on the
 * final-outcome field (`invoiceProvider` / `zohoInvoiceId`).
 */
export async function createPrimaryInvoice(
  ctx: ZohoInvoiceContext,
  options: {
    maxAttempts?: number;
    retryDelayMs?: number;
    claimOptions?: ZohoClaimOptions;
  } = {}
): Promise<PrimaryInvoiceResult> {
  // Same zero-amount/trial skip as createZohoInvoice — applies before we
  // even decide which engine would issue the invoice. See CLAUDE.md "Trial
  // order invoice policy".
  const orderAmount = ctx.order?.amount;
  const orderType = ctx.order?.orderType;
  if (!orderAmount || orderAmount <= 0 || orderType === "hosting_trial") {
    return { invoiceId: "", invoiceNumber: null, provider: "skipped" };
  }

  try {
    // Passed through whole; the primary claim reads only `staleClaimAfterMs`
    // and ignores the Zoho-specific `allowNull`/`allowFailed`.
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

    // Fallback disabled: do NOT paper over the failure with a Zoho-numbered
    // invoice. Rethrow so the caller's existing handling records it durably
    // (SystemLog + `zohoInvoiceId: 'creation_failed'`) and the order shows up
    // in admin integration-health. The customer's payment succeeded but is
    // temporarily uninvoiced — that is the documented trade of turning the
    // fallback off, and it needs an operator, not silence.
    if (!isZohoInvoiceFallbackEnabled()) {
      serverLogger.error(
        `❌ [PrimaryInvoice] Engine failed for order ${ctx.orderId} and the Zoho fallback is DISABLED ` +
        `(ZOHO_INVOICE_FALLBACK_ENABLED) — order will be left UNINVOICED pending operator action: ${message}`
      );
      throw err;
    }

    serverLogger.error(
      `❌ [PrimaryInvoice] Engine failed for order ${ctx.orderId} — falling back to Zoho: ${message}`
    );
    return { ...(await createZohoInvoice(ctx, options)), provider: "zoho" };
  }
}
