import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { clearOrderInvoiceNumber, getOrderByIdOrOrderId } from "@/lib/services/orders";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/orders/[id]/clear-invoice-number
 *
 * Admin-only. Unsets the `invoiceNumber` field on a specific Order so the
 * unique-index value is freed. Used to resolve invoiceNumber collisions when
 * an orphan or duplicate Order is holding a number that legitimately belongs
 * to another Order awaiting reconciliation. Does NOT touch zohoInvoiceId.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const adminUser = await AuthService.getUserFromRequest(request);
    if (!adminUser || adminUser.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const order = await getOrderByIdOrOrderId(id, { select: "_id orderId invoiceNumber" });
    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    const previous = order.invoiceNumber;
    if (!previous) {
      return NextResponse.json({
        success: true,
        message: "Order already has no invoiceNumber",
        orderId: order.orderId,
      });
    }

    await clearOrderInvoiceNumber(order._id);

    serverLogger.info(
      `[Admin] Cleared invoiceNumber "${previous}" on order ${order.orderId} (by ${adminUser.email})`
    );

    return NextResponse.json({
      success: true,
      message: `Cleared invoiceNumber "${previous}" — the value is now free for another Order to claim.`,
      orderId: order.orderId,
      previousInvoiceNumber: previous,
    });
  } catch (err: unknown) {
    serverLogger.error("[Admin] clear-invoice-number failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Action failed" },
      { status: 500 }
    );
  }
}
