import { NextRequest, NextResponse } from "next/server";
import { ResellerClubWrapper } from "@/lib/resellerclub-wrapper";
import { ResellerClubAPI } from "@/lib/resellerclub";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import Order from "@/models/Order";
import { appendUserDomain } from "@/lib/services/users";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    // Check authentication
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const domainName = searchParams.get("domainName");
    const years = parseInt(searchParams.get("years") || "1");

    if (!domainName) {
      return NextResponse.json(
        { error: "Domain name is required" },
        { status: 400 }
      );
    }

    // Get renewal pricing
    const pricingResult = await ResellerClubAPI.getRenewalPricing(
      domainName,
      years
    );

    if (pricingResult.status === "error") {
      return NextResponse.json(
        { error: pricingResult.message },
        { status: 500 }
      );
    }

    // Get domain expiry date
    const expiryResult = await ResellerClubAPI.getDomainExpiry(domainName);

    return NextResponse.json({
      success: true,
      domainName,
      years,
      pricing: pricingResult.data,
      expiry: expiryResult.data,
    });
  } catch (error) {
    serverLogger.error("Domain renewal info error:", error);
    return NextResponse.json(
      { error: "Failed to get domain renewal information" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    // Check authentication
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { domainName, years, paymentId } = await request.json();

    if (!domainName || !years || !paymentId) {
      return NextResponse.json(
        { error: "Domain name, years, and payment ID are required" },
        { status: 400 }
      );
    }

    // Connect to database
    await connectDB();

    // Renew domain
    const result = await ResellerClubWrapper.renewDomain(domainName, years);

    if (result.status === "error") {
      return NextResponse.json({ error: result.message }, { status: 500 });
    }

    // Create order record for renewal
    const order = new Order({
      orderId: `RENEW_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      userId: user._id,
      userName: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
      userEmail: user.email,
      paymentId,
      amount: result.data?.price || 0,
      currency: "INR",
      status: "completed",
      domains: [
        {
          domainName,
          price: result.data?.price || 0,
          currency: "INR",
          registrationPeriod: years,
          status: "registered",
          orderId: result.data?.orderid,
          expiresAt: new Date(Date.now() + years * 365 * 24 * 60 * 60 * 1000),
        },
      ],
      successfulDomains: [domainName],
    });

    await order.save();

    // Update user's domain list
    await appendUserDomain(String(user._id), {
      domainName,
      price: result.data?.price || 0,
      currency: "INR",
      registrationPeriod: years,
      status: "registered",
      orderId: result.data?.orderid,
      expiresAt: new Date(Date.now() + years * 365 * 24 * 60 * 60 * 1000),
    });

    return NextResponse.json({
      success: true,
      message: "Domain renewed successfully",
      orderId: order.orderId,
      domainName,
      years,
      newExpiryDate: new Date(Date.now() + years * 365 * 24 * 60 * 60 * 1000),
    });
  } catch (error) {
    serverLogger.error("Domain renewal error:", error);
    return NextResponse.json(
      { error: "Failed to renew domain" },
      { status: 500 }
    );
  }
}
