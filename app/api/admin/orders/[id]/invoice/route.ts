import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import type { IOrder } from "@/models/Order";
import { getOrderById } from "@/lib/services/orders";
import type { IUser } from "@/models/User";
import { ZohoBooksService } from "@/lib/zohobooks";
import { formatIndianDate } from "@/lib/dateUtils";
import jsPDF from "jspdf";

import { SAC_CODE, formatSubscriptionPeriod, formatQuantityText } from "@/lib/invoiceUtils";
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
       return generateCustomPdf(order, customer);
    }

    // Fetch from Zoho Books
    const zohoService = ZohoBooksService.getInstance();
    const pdfBuffer = await zohoService.getInvoicePdf(order.zohoInvoiceId);

    if (!pdfBuffer) {
        return generateCustomPdf(order, customer, "System is syncing this invoice. Performance copy below.");
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

/**
 * Mirror the professional layout from the user-side
 */
function generateCustomPdf(order: IOrder, user: IUser, message?: string) {
    const pdf = new jsPDF();
    const margin = 15;
    let y = 20;

    // --- Header Section ---
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(18);
    pdf.setTextColor(40, 40, 40);
    pdf.text("Anutech Digital Private Limited", margin, y);
    
    pdf.setFontSize(22);
    pdf.setTextColor(60, 60, 60);
    pdf.text("Proforma Invoice", 140, y);
    
    y += 8;
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(10);
    pdf.setTextColor(80, 80, 80);
    pdf.text("GSTIN: 07ABDCA0298H1ZP", margin, y);
    
    y += 12;
    // --- Invoice Info Box ---
    pdf.setDrawColor(200, 200, 200);
    pdf.line(margin, y, 195, y); // Top Line
    y += 2;
    
    pdf.setFont("helvetica", "bold");
    pdf.text("#", margin, y + 5);
    pdf.text("Invoice Date", margin, y + 11);
    pdf.text("Order ID", margin, y + 17);
    
    pdf.setFont("helvetica", "normal");
    pdf.text(`: ${order.invoiceNumber || "PI/PENDING/" + order.orderId.slice(-4).toUpperCase()}`, margin + 30, y + 5);
    pdf.text(`: ${formatIndianDate(order.createdAt)}`, margin + 30, y + 11);
    pdf.text(`: ${order.orderId}`, margin + 30, y + 17);
    
    // Right side info
    pdf.setFont("helvetica", "bold");
    pdf.text("Place Of Supply", 110, y + 5);
    pdf.setFont("helvetica", "normal");
    pdf.text(`: ${user.address?.state || "N/A"}`, 145, y + 5);
    
    y += 22;
    pdf.line(margin, y, 195, y); // Bottom Line
    
    y += 10;
    // --- Bill To Section ---
    pdf.setFillColor(245, 245, 245);
    pdf.rect(margin, y, 180, 7, "F");
    pdf.setFont("helvetica", "bold");
    pdf.text("Bill To", margin + 2, y + 5);
    
    y += 12;
    pdf.setTextColor(0, 102, 204);
    pdf.setFontSize(12);
    pdf.text(`${user.firstName} ${user.lastName}`.toUpperCase(), margin, y);
    
    pdf.setFontSize(10);
    pdf.setTextColor(50, 50, 50);
    pdf.setFont("helvetica", "normal");
    
    y += 5;
    if (user.companyName) {
        pdf.text(user.companyName, margin, y);
        y += 5;
    }
    
    if (user.address) {
        const addr = user.address;
        const line1 = addr.line1 || "";
        const cityState = `${addr.city || ""}, ${addr.state || ""} ${addr.zipcode || ""}`.trim();
        const country = addr.country === "IN" ? "India" : addr.country || "";
        
        pdf.text(line1, margin, y);
        y += 5;
        pdf.text(cityState, margin, y);
        y += 5;
        pdf.text(country, margin, y);
        y += 5;
    }
    
    if (user.gstNumber) {
        pdf.setFont("helvetica", "bold");
        pdf.text(`GSTIN ${user.gstNumber}`, margin, y);
        y += 7;
    } else {
        y += 2;
    }
    
    y += 5;
    // --- Table Header ---
    pdf.setFillColor(240, 240, 240);
    pdf.rect(margin, y, 180, 8, "F");
    pdf.setDrawColor(180, 180, 180);
    pdf.rect(margin, y, 180, 8, "S");
    
    pdf.setFont("helvetica", "bold");
    pdf.text("#", margin + 2, y + 5.5);
    pdf.text("Item & Description", margin + 12, y + 5.5);
    pdf.text("Qty", margin + 120, y + 5.5);
    pdf.text("Rate", margin + 145, y + 5.5);
    pdf.text("Amount", margin + 165, y + 5.5);
    
    y += 8;
    
    // --- Table Items ---
    let index = 1;
    for (const item of order.domains) {
        const itemY = y;
        pdf.setFont("helvetica", "normal");
        pdf.text(index.toString(), margin + 2, y + 6);
        
        const isDomain = item.itemType === "domain";
        const title = isDomain ? "Domain Registration / Renewal" : `Web Hosting - ${item.hostingPlan?.name || "Service"}`;
        
        pdf.setFont("helvetica", "bold");
        pdf.text(title, margin + 12, y + 6);
        
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(9);
        y += 5;
        pdf.text(`Domain Name: ${item.domainName}`, margin + 12, y + 6);
        y += 4;
        
        const periodText = formatSubscriptionPeriod(new Date(order.createdAt), item.registrationPeriod, item.periodUnit || "years");
        pdf.text(`Subscription Period: ${periodText}`, margin + 12, y + 6);
        y += 4;
        pdf.text(`SAC: ${SAC_CODE}`, margin + 12, y + 6);
        
        pdf.setFontSize(10);
        const qtyText = formatQuantityText(item.registrationPeriod, item.periodUnit || "years", item.itemType);
        const qtyLines = qtyText.split("\n");
        pdf.text(qtyLines[0], margin + 120, itemY + 6);
        pdf.setFontSize(8);
        pdf.text(qtyLines[1], margin + 120, itemY + 10);
        
        pdf.setFontSize(10);
        pdf.text(item.price.toFixed(2), margin + 145, itemY + 6);
        pdf.text(item.price.toFixed(2), margin + 165, itemY + 6);
        
        y += 12;
        
        pdf.setDrawColor(230, 230, 230);
        pdf.line(margin + 10, itemY, margin + 10, y + 2);
        pdf.line(margin + 115, itemY, margin + 115, y + 2);
        pdf.line(margin + 140, itemY, margin + 140, y + 2);
        pdf.line(margin + 162, itemY, margin + 162, y + 2);
        
        pdf.line(margin, y + 2, 195, y + 2);
        y += 5;
        index++;
    }
    
    y += 5;
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(11);
    pdf.text("Total Amount", 130, y);
    pdf.text(`${order.currency} ${order.amount.toFixed(2)}`, 165, y);
    
    if (message) {
        y += 15;
        pdf.setFontSize(9);
        pdf.setFont("helvetica", "italic");
        pdf.setTextColor(150, 0, 0);
        pdf.text(message, margin, y);
    }
    
    const buffer = pdf.output("arraybuffer");
    
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="Proforma-Admin-${order.orderId}.pdf"`,
      },
    });
}
