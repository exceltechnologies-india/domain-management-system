import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { RazorpayService } from "@/lib/razorpay";
import { ZohoBooksService } from "@/lib/zohobooks";
import connectDB from "@/lib/mongodb";
import Order from "@/models/Order";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: invoiceId } = await params;
    if (!invoiceId) {
      return NextResponse.json({ error: "Invoice ID is required" }, { status: 400 });
    }

    // SECURITY: ownership gate. The invoice id comes from the URL, so we
    // can't trust it. Confirm there's a local Order owned by this user
    // that references this zohoInvoiceId before fetching from Zoho. Mirrors
    // the pattern used in the sibling `/invoices/[id]/pdf/route.ts`.
    // Without this gate, any logged-in user can enumerate Zoho invoice IDs
    // and either pay or peek at another tenant's invoice metadata.
    await connectDB();
    const ownedOrder = await Order.findOne({
      userId: user._id,
      zohoInvoiceId: invoiceId,
      isDeleted: { $ne: true },
    }).select("_id zohoInvoiceId");

    if (!ownedOrder) {
      serverLogger.warn(
        `[INVOICE-PAY] User ${user._id} attempted to pay invoice ${invoiceId} that doesn't belong to them`
      );
      // 404 (not 403) to avoid leaking whether the invoice exists for some
      // other user — same response shape as the "no such invoice" case below.
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    }

    const zohoService = ZohoBooksService.getInstance();
    const invoice = await zohoService.getInvoiceById(invoiceId);

    if (!invoice) {
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    }

    if (invoice.balance <= 0) {
      return NextResponse.json({ error: "Invoice is already paid" }, { status: 400 });
    }

    // Generate a unique receipt ID for this renewal order
    const orderReceiptId = `rnw_${invoiceId}_${Date.now()}`;

    // Create Razorpay order
    const razorpayOrder = await RazorpayService.createOrder(
      invoice.balance ?? 0,
      ((invoice.currency_code as string | undefined) || "INR"),
      orderReceiptId,
      {
        type: 'invoice_payment',
        invoice_id: invoiceId,
        user_id: user._id?.toString() || user.id,
        email: user.email
      }
    );

    return NextResponse.json({
      success: true,
      razorpayOrderId: razorpayOrder.id,
      amount: invoice.balance,
      currency: invoice.currency_code || "INR",
      invoiceNumber: invoice.invoice_number,
      orderId: orderReceiptId
    });

  } catch (error: unknown) {
    serverLogger.error("❌ [INVOICE-PAY] Error:", error);
    return NextResponse.json(
      { error: "Failed to initiate payment" },
      { status: 500 }
    );
  }
}
