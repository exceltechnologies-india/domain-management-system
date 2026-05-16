import { AUTH_SECRET } from "@/lib/auth-secret";
import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { getToken } from "next-auth/jwt";
import connectDB from "@/lib/mongodb";
import Order from "@/models/Order";
import { getUserByIdSafe } from "@/lib/services/users";
import { ZohoBooksService } from "@/lib/zohobooks";
import { formatIndianDate } from "@/lib/dateUtils";
import jsPDF from "jspdf";

import { SAC_CODE, formatSubscriptionPeriod, formatQuantityText } from "@/lib/invoiceUtils";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await connectDB();

    // Try JWT first, then NextAuth session
    let user = await AuthService.getUserFromRequest(request);

    // If no user from JWT, try NextAuth session via getToken (works with cookies)
    if (!user) {
      const token = await getToken({
        req: request,
        secret: AUTH_SECRET,
      });

      if (token?.id) {
        // Get user by id from NextAuth token
        user = await getUserByIdSafe(token.id);

        if (!user || (!user.isActive && user.role !== "admin")) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
      }
    }

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const orderData = await Order.findOne({
      _id: id,
      userId: user._id,
    }).exec();

    if (!orderData) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    const order = orderData as any;

    // Even if Zoho ID exists, if the user wants THIS specific look for "Proforma", 
    // we use our local generator. But usually, Zoho is preferred once synced.
    if (!order.zohoInvoiceId) {
       return generateCustomPdf(order, user);
    }

    // Fetch from Zoho Books
    const zohoService = ZohoBooksService.getInstance();
    const pdfBuffer = await zohoService.getInvoicePdf(order.zohoInvoiceId);

    if (!pdfBuffer) {
        // Fallback if Zoho fetch fails
        return generateCustomPdf(order, user, "System is syncing your invoice. This is a proforma copy.");
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
 * Generate a high-quality "Proforma Invoice" matching the user's requested layout.
 */
function generateCustomPdf(order: any, user: any, message?: string) {
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
    pdf.setTextColor(0, 102, 204); // Proforma Blue for customer name
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
        
        // Item Details
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
        
        // Horizontal lines between rows
        // pdf.line(margin, y + 10, 195, y + 10);
        
        // Values in columns
        pdf.setFontSize(10);
        const qtyText = formatQuantityText(item.registrationPeriod, item.periodUnit || "years", item.itemType);
        const qtyLines = qtyText.split("\n");
        pdf.text(qtyLines[0], margin + 120, itemY + 6);
        pdf.setFontSize(8);
        pdf.text(qtyLines[1], margin + 120, itemY + 10);
        
        pdf.setFontSize(10);
        pdf.text(item.price.toFixed(2), margin + 145, itemY + 6);
        pdf.text(item.price.toFixed(2), margin + 165, itemY + 6);
        
        y += 12; // Extra spacing between items
        
        // Vertical grid lines (simulated)
        pdf.setDrawColor(230, 230, 230);
        pdf.line(margin + 10, itemY, margin + 10, y + 2);
        pdf.line(margin + 115, itemY, margin + 115, y + 2);
        pdf.line(margin + 140, itemY, margin + 140, y + 2);
        pdf.line(margin + 162, itemY, margin + 162, y + 2);
        
        pdf.line(margin, y + 2, 195, y + 2);
        y += 5;
        index++;
    }
    
    // --- Totals ---
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
        "Content-Disposition": `attachment; filename="Proforma-${order.orderId}.pdf"`,
      },
    });
}
