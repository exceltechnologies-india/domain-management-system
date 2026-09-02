import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { getOrderById } from "@/lib/services/orders";
import { ZohoBooksService } from "@/lib/zohobooks";
import { generateInvoicePdf } from "@/lib/billing/pdf";
import { getUserById } from "@/lib/services/users";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await AuthService.getAdminFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const order = await getOrderById(id);

    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    // Fetch the customer for this order
    const customer = await getUserById(String(order.userId));
    if (!customer) {
        return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    }

    // Check for Zoho Invoice ID
    if (!order.zohoInvoiceId) {
       return generateInvoicePdf(order, customer, { adminContext: true });
    }

    // Fetch from Zoho Books
    const zohoService = ZohoBooksService.getInstance();
    const pdfBuffer = await zohoService.getInvoicePdf(order.zohoInvoiceId);

    if (!pdfBuffer) {
        return generateInvoicePdf(order, customer, {
          adminContext: true,
          message: "System is syncing this invoice. Performance copy below.",
        });
    }

    return new NextResponse(pdfBuffer, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="Invoice-${
          order.invoiceNumber || order.orderId
        }.pdf"`,
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
