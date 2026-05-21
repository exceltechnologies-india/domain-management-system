import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { ZohoBooksService } from "@/lib/zohobooks";
import connectDB from "@/lib/mongodb";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: invoiceId } = await params;
    if (!invoiceId) {
        return NextResponse.json({ error: "Invoice ID required" }, { status: 400 });
    }

    await connectDB();
    
    const user = await AuthService.getAdminFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const zohoService = ZohoBooksService.getInstance();
    const pdfBuffer = await zohoService.getInvoicePdf(invoiceId);

    if (!pdfBuffer) {
      return NextResponse.json(
        { error: "Failed to fetch PDF from Zoho" },
        { status: 404 }
      );
    }

    // Return PDF
    return new NextResponse(pdfBuffer, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="Invoice-${invoiceId}.pdf"`,
      },
    });

  } catch (error) {
    serverLogger.error("Failed to download admin invoice:", error);
    return NextResponse.json(
      { error: "Failed to download invoice" },
      { status: 500 }
    );
  }
}
