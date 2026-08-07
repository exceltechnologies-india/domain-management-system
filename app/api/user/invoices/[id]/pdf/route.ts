import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { ZohoBooksService } from "@/lib/zohobooks";
import { rateLimiters, rateLimitResponse } from "@/lib/rate-limit";
import { serverLogger } from "@/lib/server-logger";
import {
  findOrderByZohoInvoiceForUser,
  findOrderByBillingInvoiceForUser,
} from "@/lib/services/orders";
import { getBillingInvoices } from "@/lib/integrations/billing-customer";
import { resolveUserBillingCustomerId } from "@/lib/services/users";

// Force dynamic rendering
export const dynamic = "force-dynamic";

// Sentinel values written by the invoice-creation flow — not real invoice IDs
const INVOICE_SENTINEL = new Set(["pending_creation", "creation_failed"]);

// Fetch the PDF server-side and return the bytes under Customer Panel's own
// origin, rather than redirecting the browser to Billing's origin directly.
// A redirect works fine for a plain navigation/download link, but the
// inline viewer reads the response via fetch().blob() — a cross-origin
// redirect there hits the browser's CORS check on Billing's response,
// which doesn't (and doesn't need to) send Customer-Panel-facing CORS
// headers. Proxying server-side sidesteps that entirely: the browser only
// ever talks to Customer Panel's own origin.
async function proxyPdf(url: string, filename: string): Promise<NextResponse> {
  const res = await fetch(url);
  if (!res.ok) {
    return NextResponse.json({ error: "Invoice not available" }, { status: 404 });
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}.pdf"`,
    },
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Rate limit: 10 PDF downloads per minute per user
    const rl = await rateLimiters.pdfInvoice.checkKey(`pdf_invoice:${user._id}`);
    if (!rl.allowed) {
      return rateLimitResponse(rl, {
        limit: 10,
        message: "Too many requests. Please wait before downloading again.",
      });
    }

    if (INVOICE_SENTINEL.has(id)) {
      return NextResponse.json({ error: "Invoice not available" }, { status: 404 });
    }

    // Billing Panel (ResellerOS) invoices carry their own signed, ready-to-open
    // PDF link — no server-side proxy needed, just redirect. Checked first
    // since this is the live path for every order going forward.
    const billingOrder = await findOrderByBillingInvoiceForUser(user._id, id, {
      select: "billingInvoicePdfUrl",
    });
    if (billingOrder) {
      if (!billingOrder.billingInvoicePdfUrl) {
        return NextResponse.json({ error: "Invoice not available" }, { status: 404 });
      }
      return proxyPdf(billingOrder.billingInvoicePdfUrl, `Invoice-${id}`);
    }

    // Billing-native invoice with no Order row at all (created directly in
    // Billing's own UI, e.g. by staff) — verify ownership against Billing's
    // own invoice list for this customer instead of a local Order.
    const billingCustomerId = await resolveUserBillingCustomerId(user);
    if (billingCustomerId) {
      const billingInvoices = await getBillingInvoices(billingCustomerId);
      const match = billingInvoices.find((inv) => inv.id === id);
      if (match) {
        if (!match.pdf_url) return NextResponse.json({ error: "Invoice not available" }, { status: 404 });
        return proxyPdf(match.pdf_url, `Invoice-${id}`);
      }
    }

    // Legacy path — invoices created before the Billing Panel cutover.
    const order = await findOrderByZohoInvoiceForUser(user._id, id, { select: "_id" });
    if (!order) {
      serverLogger.warn(`[Security] Unauthorized PDF access attempt by ${user.email} for invoice ${id}`);
      return NextResponse.json(
        { error: "Forbidden: You do not have access to this invoice" },
        { status: 403 }
      );
    }

    const zohoService = ZohoBooksService.getInstance();
    const pdfBuffer = await zohoService.getInvoicePdf(id);

    if (!pdfBuffer) {
      return NextResponse.json({ error: "Failed to generate PDF" }, { status: 500 });
    }

    return new NextResponse(pdfBuffer, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="Invoice-${id}.pdf"`,
      },
    });
  } catch (error) {
    serverLogger.error("Failed to fetch invoice PDF:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
