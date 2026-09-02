import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { ZohoBooksService } from "@/lib/zohobooks";
import { rateLimiters, rateLimitResponse } from "@/lib/rate-limit";
import { serverLogger } from "@/lib/server-logger";
import { findOrderByZohoInvoiceForUser } from "@/lib/services/orders";
import { generateInvoicePdf } from "@/lib/billing/pdf";

// Force dynamic rendering
export const dynamic = "force-dynamic";

// Sentinel values written by the invoice-creation flow — not real Zoho IDs
const ZOHO_SENTINEL = new Set(["pending_creation", "creation_failed"]);

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

    if (ZOHO_SENTINEL.has(id)) {
      return NextResponse.json({ error: "Invoice not available" }, { status: 404 });
    }

    // Full doc (not just _id) — the local-PDF fallback below needs domains/
    // amount/currency/etc if Zoho's own PDF fetch fails.
    const order = await findOrderByZohoInvoiceForUser(user._id, id);
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
      // Zoho is down/misconfigured — don't leave the customer with a bare
      // 500 on their own invoice download. This order is necessarily
      // Zoho-issued (it's looked up BY zohoInvoiceId), so the fallback
      // renders as a Proforma copy, not a Tax Invoice.
      return generateInvoicePdf(order, user, {
        message: "System is syncing your invoice. This is a proforma copy.",
      });
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
