import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { ResellerClubWrapper } from "@/lib/resellerclub-wrapper";
import connectDB from "@/lib/mongodb";
import Order, { type IOrder } from "@/models/Order";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    // Check authentication
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { domainName, force } = await request.json();

    if (!domainName) {
      return NextResponse.json(
        { error: "Domain name is required" },
        { status: 400 }
      );
    }

    await connectDB();

    // Find the order containing this domain
    const order = await Order.findOne({
      userId: user._id,
      "domains.domainName": domainName,
    });

    if (!order) {
      return NextResponse.json({ error: "Domain not found" }, { status: 404 });
    }

    // Find the specific domain in the order
    const domain = order.domains.find((d: IOrder['domains'][number]) => d.domainName === domainName);

    if (!domain) {
      return NextResponse.json(
        { error: "Domain not found in order" },
        { status: 404 }
      );
    }

    // Check if domain is registered
    if (domain.status !== "registered") {
      return NextResponse.json(
        { error: "Domain must be registered to activate DNS management" },
        { status: 400 }
      );
    }

    // Check if DNS is already activated
    if (domain.dnsActivated && !force) {
      return NextResponse.json(
        { error: "DNS management is already activated for this domain" },
        { status: 400 }
      );
    }

    // No additional calculations needed - amount is the total

    // Call ResellerClub API first — do not mark success locally until the API confirms
    const resellerOrderId = domain.resellerClubOrderId || order.resellerClubOrderId;

    if (resellerOrderId) {
      let activationResult;
      try {
        activationResult = await ResellerClubWrapper.activateDNSManagement(
          domainName,
          resellerOrderId.toString()
        );
      } catch (apiError: unknown) {
        serverLogger.error("Failed to call ResellerClub DNS activation:", apiError);
        return NextResponse.json(
          { error: "DNS activation failed: could not reach registrar" },
          { status: 502 }
        );
      }

      if (activationResult.status === "error") {
        serverLogger.error("ResellerClub DNS activation returned error:", activationResult.message);
        return NextResponse.json(
          { error: activationResult.message || "DNS activation failed at registrar" },
          { status: 502 }
        );
      }
    } else {
      serverLogger.warn(`No ResellerClub Order ID found for domain ${domainName}, skipping API activation`);
    }

    // API succeeded (or no orderId — local-only): mark locally
    domain.dnsActivated = true;
    domain.dnsActivatedAt = new Date();

    // Add to booking status
    if (!domain.bookingStatus) {
      domain.bookingStatus = [];
    }

    domain.bookingStatus.push({
      step: "dns_activated",
      message: "DNS management activated successfully",
      timestamp: new Date(),
      progress: 100,
    });

    // Save the updated order
    await order.save();

    return NextResponse.json({
      success: true,
      message: "DNS management activated successfully",
      domainName,
      dnsActivated: true,
      dnsActivatedAt: domain.dnsActivatedAt,
    });
  } catch (error) {
    serverLogger.error("DNS activation error:", error);
    return NextResponse.json(
      { error: "Failed to activate DNS management" },
      { status: 500 }
    );
  }
}
