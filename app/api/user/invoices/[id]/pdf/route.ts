import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { ZohoBooksService } from "@/lib/zohobooks";
import { rateLimiters, rateLimitResponse } from "@/lib/rate-limit";
import { serverLogger } from "@/lib/server-logger";
import { findOrderByZohoInvoiceForUser } from "@/lib/services/orders";

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

    // Security check: verify ownership via MongoDB — avoids 2 round-trips to Zoho
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
