import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import Order from "@/models/Order";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    // Check admin authentication
    const user = await AuthService.getUserFromRequest(request);
    if (!user || user.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Connect to database
    await connectDB();

    // Find the order
    const order = await Order.findById(id);
    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    // Check if permanent deletion is requested
    const { searchParams } = new URL(request.url);
    const permanent = searchParams.get('permanent') === 'true';

    if (permanent) {
       await Order.findByIdAndDelete(id);
       serverLogger.info(
        `✅ [ADMIN] Order PERMANENTLY deleted: ${order.orderId} by admin: ${user.email}`
       );
       return NextResponse.json({
        success: true,
        message: "Order permanently deleted",
        deletedOrderId: order.orderId,
       });
    }

    // Soft delete the order
    await Order.findByIdAndUpdate(id, {
      isDeleted: true,
      deletedAt: new Date(),
    });

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
    return NextResponse.json(
      { error: "Failed to delete order" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    // Check admin authentication
    const user = await AuthService.getUserFromRequest(request);
    if (!user || user.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Connect to database
    await connectDB();

    // Find the order
    const order = await Order.findById(id);
    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    // Un-archive the order
    await Order.findByIdAndUpdate(id, {
      isDeleted: false,
      $unset: { deletedAt: 1 },
    });

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
    return NextResponse.json(
      { error: "Failed to un-archive order" },
      { status: 500 }
    );
  }
}
