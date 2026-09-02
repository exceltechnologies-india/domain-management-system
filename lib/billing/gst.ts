/**
 * GST tax-treatment engine for the primary invoicing system
 * (lib/services/billing/createPrimaryInvoice.ts).
 *
 * This is a from-scratch calculation, deliberately independent of
 * lib/zohobooks.ts — when invoiceProvider === 'primary' there is no Zoho
 * invoice at all, so this module (not Zoho) is the system of record for the
 * tax breakdown printed on the customer's legal invoice.
 *
 * Same interstate/intrastate rule as Zoho's (org state vs customer billing
 * state -> CGST+SGST or IGST), reimplemented locally rather than reusing
 * lib/zohobooks.ts's private ORG_STATE getter, which is coupled to the Zoho
 * service class and throws on Zoho-specific setup.
 */

export interface GstBreakdown {
  /** GST-exclusive value the tax is calculated on. */
  taxableValue: number;
  gstRate: number;
  isInterState: boolean;
  cgst: number;
  sgst: number;
  igst: number;
  totalTax: number;
  /** Equal to the gross amount passed in — kept for convenience at call sites. */
  totalAmount: number;
}

export const DEFAULT_GST_RATE = 18;

function normalizeState(state: string): string {
  return state.trim().toLowerCase();
}

/**
 * No customer state on file is treated as intra-state (CGST+SGST) rather
 * than inter-state — matches the conservative fallback already used by the
 * Zoho integration's own contact/GST handling, and avoids charging IGST
 * against a supply we can't actually prove crossed a state line.
 */
export function isInterStateSupply(
  orgState: string,
  customerState: string | undefined | null
): boolean {
  if (!customerState || !customerState.trim()) return false;
  return normalizeState(orgState) !== normalizeState(customerState);
}

export function placeOfSupply(customerState: string | undefined | null): string {
  return customerState && customerState.trim() ? customerState.trim() : "N/A";
}

/**
 * `grossAmount` is GST-inclusive, matching how Order.amount / domains[].price
 * are stored today. Taxable value is back-computed the same way as a
 * gross-first pricing model: taxable = gross * 100 / (100 + rate).
 *
 * Tax split is rounded to paise (2dp) with SGST computed as the remainder
 * of totalTax - cgst (not totalTax/2 again) so a paisa of rounding drift
 * never causes cgst + sgst to disagree with totalTax.
 */
export function computeGstBreakdown(
  grossAmount: number,
  orgState: string,
  customerState: string | undefined | null,
  gstRate: number = DEFAULT_GST_RATE
): GstBreakdown {
  const interState = isInterStateSupply(orgState, customerState);

  const taxableValue = round2((grossAmount * 100) / (100 + gstRate));
  const totalTax = round2(grossAmount - taxableValue);

  const cgst = interState ? 0 : round2(totalTax / 2);
  const sgst = interState ? 0 : round2(totalTax - cgst);
  const igst = interState ? totalTax : 0;

  return {
    taxableValue,
    gstRate,
    isInterState: interState,
    cgst,
    sgst,
    igst,
    totalTax,
    totalAmount: grossAmount,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
