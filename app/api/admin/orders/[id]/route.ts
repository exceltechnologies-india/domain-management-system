import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import {
  getOrderById,
  softDeleteOrder,
  permanentlyDeleteOrder,
  unarchiveOrder,
} from "@/lib/services/orders";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await AuthService.getUserFromRequest(request);
    if (!user || user.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const order = await getOrderById(id);
    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    const permanent = new URL(request.url).searchParams.get("permanent") === "true";

    if (permanent) {
      await permanentlyDeleteOrder(id);
      serverLogger.info(
        `✅ [ADMIN] Order PERMANENTLY deleted: ${order.orderId} by admin: ${user.email}`
      );
      return NextResponse.json({
        success: true,
        message: "Order permanently deleted",
        deletedOrderId: order.orderId,
      });
    }

    await softDeleteOrder(id);
    serverLogger.info(
      `✅ [ADMIN] Order soft deleted: ${order.orderId} by admin: ${user.email}`
    );

    return NextResponse.json({
      success: true,
      message: "Order archived successfully",
      deletedOrderId: order.orderId,
    });
  } catch (error) {
    serverLogger.error("Failed to delete order:", error);
    return NextResponse.json({ error: "Failed to delete order" }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await AuthService.getUserFromRequest(request);
    if (!user || user.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const order = await unarchiveOrder(id);
    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    serverLogger.info(
      `✅ [ADMIN] Order un-archived: ${order.orderId} by admin: ${user.email}`
    );

    return NextResponse.json({
      success: true,
      message: "Order un-archived successfully",
      orderId: order.orderId,
    });
  } catch (error) {
    serverLogger.error("Failed to un-archive order:", error);
    return NextResponse.json({ error: "Failed to un-archive order" }, { status: 500 });
  }
}
