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

export function getCompanyProfile(): CompanyProfile {
  const state = process.env.ZOHO_ORG_STATE;
  if (!state) {
    throw new Error(
      "ZOHO_ORG_STATE environment variable is required for GST place-of-supply calculation"
    );
  }

  return {
    name: process.env.COMPANY_NAME || "Anutech Digital Private Limited",
    // Matches the literal already hardcoded in the admin proforma PDF
    // (app/api/admin/orders/[id]/invoice/route.ts) — same GSTIN, single
    // source now for the primary engine.
    gstin: process.env.COMPANY_GSTIN || "07ABDCA0298H1ZP",
    state,
    address: process.env.COMPANY_ADDRESS || "",
    supportEmail: process.env.SUPPORT_EMAIL || "",
    sacCode: SAC_CODE,
  };
}
