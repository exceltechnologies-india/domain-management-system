import { SAC_CODE } from "@/lib/invoiceUtils";

/**
 * Our own GST-registered company profile, used by the primary invoicing
 * engine (lib/services/billing/createPrimaryInvoice.ts) to render tax
 * invoices without depending on Zoho's org settings.
 *
 * Reuses ZOHO_ORG_STATE rather than a second env var — it's the same
 * legal entity/GSTIN either way, and ZOHO_ORG_STATE is already a required
 * production env var (lib/zohobooks.ts throws without it).
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
 * `state` is deliberately NOT required here (unlike lib/zohobooks.ts's
 * ORG_STATE, which throws) — this profile also backs PDF rendering for the
 * Zoho-fallback Proforma path (lib/billing/pdf.ts), which must keep working
 * even if ZOHO_ORG_STATE is ever unset, since that's exactly the kind of
 * misconfiguration the fallback exists to survive. A missing state only
 * matters to actual GST math: lib/services/billing/createPrimaryInvoice.ts
 * (Phase 1c) checks it explicitly before calling computeGstBreakdown, since
 * failing loud belongs at the point tax is calculated, not at display time.
 */
export function getCompanyProfile(): CompanyProfile {
  return {
    name: process.env.COMPANY_NAME || "Anutech Digital Private Limited",
    // Matches the literal already hardcoded in the admin proforma PDF
    // (app/api/admin/orders/[id]/invoice/route.ts) — same GSTIN, single
    // source now for the primary engine.
    gstin: process.env.COMPANY_GSTIN || "07ABDCA0298H1ZP",
    state: process.env.ZOHO_ORG_STATE || "",
    address: process.env.COMPANY_ADDRESS || "",
    supportEmail: process.env.SUPPORT_EMAIL || "",
    sacCode: SAC_CODE,
  };
}
