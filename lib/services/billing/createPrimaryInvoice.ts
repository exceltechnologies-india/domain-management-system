import type { IOrder } from "@/models/Order";
import type { IUser } from "@/models/User";
import { serverLogger } from "@/lib/server-logger";
import { isPrimaryBillingEnabled } from "@/lib/primary-billing-flag";
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
  user: IUser
): Promise<{ invoiceNumber: string } | null> {
  const claimed = await claimOrderForPrimaryInvoice(order._id);
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
 *  - `PRIMARY_BILLING_ENABLED` unset/false (default): calls `createZohoInvoice`
 *    directly — byte-identical to every call site's pre-existing behavior.
 *  - Enabled: tries the primary GST engine first; ANY failure (thrown error)
 *    falls back to `createZohoInvoice` so a customer's payment never goes
 *    un-invoiced just because the new engine hit a bug.
 *
 * `invoiceId` in the returned pair has no meaning for a primary invoice
 * (there's no external gateway id) — set to the same value as
 * `invoiceNumber` for callers that log it, none of which currently branch
 * on its value.
 *
 * `options.claimOptions` (e.g. `{staleClaimAfterMs}`) is forwarded to the
 * Zoho path only — recovery callers (idempotency.ts) that need to re-claim
 * a possibly-stuck order pass it so a crashed prior Zoho attempt doesn't
 * block them forever. The primary engine's own claim
 * (`claimOrderForPrimaryInvoice`) doesn't support stale-claim recovery yet:
 * every primary attempt today runs synchronously inside one request, so a
 * stuck claim can only mean a mid-request crash, not a background retry
 * gap — revisit if/when a primary-invoice retry cron is added.
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

  if (!isPrimaryBillingEnabled()) {
    return { ...(await createZohoInvoice(ctx, options)), provider: "zoho" };
  }

  try {
    const result = await attemptCreatePrimaryInvoice(ctx.order, ctx.user);
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
      `❌ [PrimaryInvoice] Engine failed for order ${ctx.orderId} — falling back to Zoho: ${message}`
    );
    return { ...(await createZohoInvoice(ctx, options)), provider: "zoho" };
  }
}
