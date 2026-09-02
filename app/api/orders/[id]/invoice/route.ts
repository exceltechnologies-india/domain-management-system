import { AUTH_SECRET } from "@/lib/auth-secret";
import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { getToken } from "next-auth/jwt";
import type { IOrder } from "@/models/Order";
import { findUserOrder } from "@/lib/services/orders";
import { getUserById } from "@/lib/services/users";
import { ZohoBooksService } from "@/lib/zohobooks";
import { generateInvoicePdf } from "@/lib/billing/pdf";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
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
        user = await getUserById(token.id);

        if (!user || (!user.isActive && user.role !== "admin")) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
      }
    }

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const orderData = await findUserOrder(id, String(user._id));

    if (!orderData) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    const order = orderData as unknown as IOrder;

    // Even if Zoho ID exists, if the user wants THIS specific look for "Proforma",
    // we use our local generator. But usually, Zoho is preferred once synced.
    if (!order.zohoInvoiceId) {
       return generateInvoicePdf(order, user);
    }

    // Fetch from Zoho Books
    const zohoService = ZohoBooksService.getInstance();
    const pdfBuffer = await zohoService.getInvoicePdf(order.zohoInvoiceId);

    if (!pdfBuffer) {
        // Fallback if Zoho fetch fails
        return generateInvoicePdf(order, user, {
          message: "System is syncing your invoice. This is a proforma copy.",
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
