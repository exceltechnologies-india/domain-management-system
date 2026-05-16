import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { serverLogger } from "@/lib/server-logger";
import { ZohoBooksService } from "@/lib/zohobooks";
import connectDB from "@/lib/mongodb";
import Order from "@/models/Order";
import { getUserById } from "@/lib/services/users";

// Force dynamic rendering
export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    
    // Check admin authentication
    const adminUser = await AuthService.getUserFromRequest(request);
    if (!adminUser || adminUser.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await connectDB();

    // Find the order by database ID or orderId
    const order = await Order.findOne({
        $or: [
            { _id: id.match(/^[0-9a-fA-F]{24}$/) ? id : undefined },
            { orderId: id }
        ].filter(Boolean)
    });

    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    serverLogger.info(`📂 [ADMIN] Manual re-sync triggered for order ${order.orderId} by admin ${adminUser.email}`);

    // Find the associated user
    const user = await getUserById(order.userId);
    if (!user) {
        return NextResponse.json({ error: "Associated user not found" }, { status: 404 });
    }

    // Reset stuck status if necessary
    if (order.zohoInvoiceId === 'pending_creation') {
        serverLogger.info(`🔓 [ADMIN] Clearing stuck 'pending_creation' status for order ${order.orderId}`);
        order.zohoInvoiceId = undefined;
    }

    const zohoService = ZohoBooksService.getInstance();
    
    // Prepare items from the order
    const invoiceItems = order.domains.map((d: any) => ({
        itemType: d.itemType || 'domain',
        domainName: d.domainName,
        price: d.price,
        registrationPeriod: d.registrationPeriod || 1,
        periodUnit: d.periodUnit || (d.itemType === 'hosting' ? 'months' : 'years'),
        hostingPlan: d.hostingPlan
    }));

    // Trigger sync
    const result = await zohoService.createInvoice(
        {
            orderId: order.orderId,
            razorpayPaymentId: order.razorpayPaymentId || order.paymentId,
            total: order.amount // In rupees — webhook stores payment.amount/100
        },
        user,
        invoiceItems,
        'Razorpay',
        true // marked as paid
    );

    if (result && result.invoice_id) {
        order.zohoInvoiceId = result.invoice_id;
        order.invoiceNumber = result.invoice_number;
        await order.save();
        
        serverLogger.info(`✅ [ADMIN] Manual re-sync success for ${order.orderId}: ${result.invoice_id}`);
        
        return NextResponse.json({
            success: true,
            message: "Invoice successfully synced with Zoho Books",
            invoice_id: result.invoice_id,
            invoice_number: result.invoice_number
        });
    } else {
        serverLogger.error(`❌ [ADMIN] Manual re-sync failed for ${order.orderId}`);
        return NextResponse.json({
            success: false,
            message: "Failed to generate invoice in Zoho Books. Check server logs for details."
        }, { status: 500 });
    }

  } catch (error: any) {
    serverLogger.error(`❌ [ADMIN] Error in manual re-sync route:`, error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
