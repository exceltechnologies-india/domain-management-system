import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import Order from "@/models/Order";
import { ResellerClubAPI } from "@/lib/resellerclub";
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

    const { domainName } = await request.json();

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

    const domain = order.domains.find((d: any) => d.domainName === domainName);

    if (!domain || !domain.resellerClubCustomerId) {
      return NextResponse.json(
        { error: "Registrar customer reference not found for this domain. Please contact support." },
        { status: 404 }
      );
    }

    // Check domain status in ResellerClub
    const result = await ResellerClubAPI.getDomainDetails(domainName);

    if (result.status === "error") {
      // If domain not found in ResellerClub, it might be pending or failed
      if (result.message && result.message.includes("404")) {
        return NextResponse.json({
          success: true,
          domainName,
          status: "pending",
          message:
            "Domain not found in ResellerClub - likely pending registration",
          resellerClubStatus: "not_found",
        });
      }

      return NextResponse.json({
        success: false,
        error: result.message,
      });
    }

    // Domain found in ResellerClub - check if it's actually registered
    const domainData = result.data;
    const isRegistered = domainData && domainData.domainstatus === "Active";

    return NextResponse.json({
      success: true,
      domainName,
      status: isRegistered ? "registered" : "pending",
      message: isRegistered
        ? "Domain is registered and active"
        : "Domain found but not yet active",
      resellerClubStatus: domainData?.domainstatus || "unknown",
      resellerClubData: domainData,
    });
  } catch (error) {
    serverLogger.error("Error verifying domain status:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
