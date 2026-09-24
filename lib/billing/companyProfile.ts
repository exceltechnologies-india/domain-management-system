import { SAC_CODE } from "@/lib/invoiceUtils";

/**
 * Our own GST-registered company profile, used by the GST invoicing engine
 * (lib/services/billing/createPrimaryInvoice.ts) and the PDF renderer
 * (lib/billing/pdf.ts).
 *
 * `COMPANY_STATE` was called ZOHO_ORG_STATE until Zoho Books was removed on
 * 24 Sep 2026. It is the same legal fact — the state our GSTIN is registered
 * in — and the deploy script refuses to ship without it.
 */
export interface CompanyProfile {
  name: string;
  gstin: string;
  state: string;
  address: string;
  supportEmail: string;
  sacCode: string;
}

/**
 * `state` is deliberately NOT required here — this profile also backs PDF
 * rendering, which should still draw a page even if COMPANY_STATE is ever
 * unset. A missing state only matters to actual GST math:
 * createPrimaryInvoice checks it explicitly before calling
 * computeGstBreakdown, since failing loud belongs at the point tax is
 * calculated, not at display time. It is never defaulted: a guessed state
 * would silently put the wrong tax head (CGST+SGST vs IGST) on a real invoice.
 */
export function getCompanyProfile(): CompanyProfile {
  return {
    name: process.env.COMPANY_NAME || "Anutech Digital Private Limited",
    // Matches the literal already hardcoded in the admin proforma PDF
    // (app/api/admin/orders/[id]/invoice/route.ts) — same GSTIN, single
    // source now for the primary engine.
    gstin: process.env.COMPANY_GSTIN || "07ABDCA0298H1ZP",
    state: process.env.COMPANY_STATE || "",
    address: process.env.COMPANY_ADDRESS || "",
    supportEmail: process.env.SUPPORT_EMAIL || "",
    sacCode: SAC_CODE,
  };
}
