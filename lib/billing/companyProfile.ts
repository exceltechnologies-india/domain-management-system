import { SAC_CODE } from "@/lib/invoiceUtils";

/**
 * Our own GST-registered company profile, read by the PDF renderer
 * (lib/billing/pdf.ts), which re-renders bills for historical orders. The GST
 * invoicing engine (createPrimaryInvoice) that also read it was deleted on
 * 25 Sep 2026.
 *
 * There is no `state` field any more (26 Sep 2026, owner: "remove the unused
 * ones"). It fed only createPrimaryInvoice's GST split, and DMS issues no
 * invoices now; the PDF renderer never read it. COMPANY_STATE is gone with it.
 */
export interface CompanyProfile {
  name: string;
  gstin: string;
  address: string;
  supportEmail: string;
  sacCode: string;
}

export function getCompanyProfile(): CompanyProfile {
  return {
    name: process.env.COMPANY_NAME || "Anutech Digital Private Limited",
    // Matches the literal already hardcoded in the admin proforma PDF
    // (app/api/admin/orders/[id]/invoice/route.ts) — same GSTIN, single
    // source for the PDF renderer.
    gstin: process.env.COMPANY_GSTIN || "07ABDCA0298H1ZP",
    address: process.env.COMPANY_ADDRESS || "",
    supportEmail: process.env.SUPPORT_EMAIL || "",
    sacCode: SAC_CODE,
  };
}
