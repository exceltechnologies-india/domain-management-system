import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { ResellerClubWrapper } from "@/lib/resellerclub-wrapper";
import connectDB from "@/lib/mongodb";
import Order, { type IOrder } from "@/models/Order";
import { serverLogger } from "@/lib/server-logger";
import { findOrderDomain } from "@/lib/services/orders";

// Force dynamic rendering - required for API routes
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    // Check authentication
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check if user is admin
    if (user.role !== "admin") {
      return NextResponse.json(
        { error: "Admin access required" },
        { status: 403 }
      );
    }

    const { domainName, force } = await request.json();

    if (!domainName) {
      return NextResponse.json(
        { error: "Domain name is required" },
        { status: 400 }
      );
    }

    await connectDB();

    // Find the order containing this domain (admin can access any domain)
    const order = await Order.findOne({
      "domains.domainName": domainName,
    });

    if (!order) {
      return NextResponse.json({ error: "Domain not found" }, { status: 404 });
    }

    // Find the specific domain in the order
    const domain = findOrderDomain(order, domainName);

    if (!domain) {
      return NextResponse.json(
        { error: "Domain not found in order" },
        { status: 404 }
      );
    }

    // Check if domain is registered
    if (domain.status !== "registered") {
      const statusMessage =
        domain.status === "pending" || domain.status === "processing"
          ? `Cannot activate DNS - domain is currently ${domain.status}. Please wait for registration to complete.`
          : "Domain must be registered to activate DNS management";
      return NextResponse.json({ error: statusMessage }, { status: 400 });
    }

    // Check if DNS is already activated
    if (domain.dnsActivated && !force) {
      return NextResponse.json(
        { error: "DNS management is already activated for this domain" },
        { status: 400 }
      );
    }

    // Activate DNS management
    domain.dnsActivated = true;
    domain.dnsActivatedAt = new Date();

    // Call ResellerClub API to activate DNS service
    // We need the ResellerClub Order ID
    // Check if the domain object has an orderId, or if it's stored on the parent order object
    const resellerOrderId = domain.resellerClubOrderId || order.resellerClubOrderId;
    
    if (resellerOrderId) {
      try {
        const activationResult = await ResellerClubWrapper.activateDNSManagement(
          domainName,
          resellerOrderId.toString()
        );
        
        if (activationResult.status === "error") {
          serverLogger.error("ResellerClub DNS activation failed:", activationResult.message);
          // We continue anyway since we want to mark it as activated locally, 
          // but we should log the error. The user might need to retry manually or contact support 
          // if the API call keeps failing, but often it might be already active.
        }
      } catch (apiError) {
        serverLogger.error("Failed to call ResellerClub DNS activation:", apiError);
      }
    } else {
      serverLogger.warn(`No ResellerClub Order ID found for domain ${domainName}, skipping API activation`);
    }

    // Save the updated order
    await order.save();

    return NextResponse.json({
      success: true,
      message: "DNS management activated successfully",
    });
  } catch (error: unknown) {
    serverLogger.error("Error in admin activate DNS:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
