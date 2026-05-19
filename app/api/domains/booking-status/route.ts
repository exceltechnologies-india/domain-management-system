import { NextRequest, NextResponse } from "next/server";
import connectDB from "@/lib/mongodb";
import Order, { type IOrder } from "@/models/Order";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    await connectDB();

    const { searchParams } = new URL(request.url);
    const orderId = searchParams.get("orderId");
    const domainName = searchParams.get("domainName");

    if (!orderId && !domainName) {
      return NextResponse.json(
        { error: "Order ID or domain name is required" },
        { status: 400 }
      );
    }

    const query: Record<string, unknown> = {};
    if (orderId) {
      query.orderId = orderId;
    }
    if (domainName) {
      query["domains.domainName"] = domainName;
    }

    const order = await Order.findOne(query).populate(
      "userId",
      "email firstName lastName"
    );

    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    // Find the specific domain if domainName was provided
    let domainData = null;
    if (domainName) {
      domainData = order.domains.find((d: IOrder['domains'][number]) => d.domainName === domainName);
    } else {
      // Return all domains if only orderId was provided
      domainData = order.domains;
    }

    return NextResponse.json({
      success: true,
      orderId: order.orderId,
      status: order.status,
      domains: domainData,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    });
  } catch (error) {
    serverLogger.error("Error fetching domain booking status:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const { orderId, domainName, step, message, progress } =
      await request.json();

    if (
      !orderId ||
      !domainName ||
      !step ||
      !message ||
      progress === undefined
    ) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    await connectDB();

    const order = await Order.findOne({ orderId });
    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    const domainIndex = order.domains.findIndex(
      (d: IOrder['domains'][number]) => d.domainName === domainName
    );
    if (domainIndex === -1) {
      return NextResponse.json(
        { error: "Domain not found in order" },
        { status: 404 }
      );
    }

    // Add new booking status step
    order.domains[domainIndex].bookingStatus.push({
      step,
      message,
      timestamp: new Date(),
      progress,
    });

    // Update domain status based on step
    if (step === "domain_registered") {
      order.domains[domainIndex].status = "registered";
    } else if (step === "domain_failed") {
      order.domains[domainIndex].status = "failed";
    } else if (step === "domain_registering") {
      order.domains[domainIndex].status = "processing";
    }

    await order.save();

    return NextResponse.json({
      success: true,
      message: "Booking status updated successfully",
    });
  } catch (error) {
    serverLogger.error("Error updating domain booking status:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
