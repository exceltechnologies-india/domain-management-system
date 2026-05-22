import { NextRequest, NextResponse } from "next/server";
import { ResellerClubAPI } from "@/lib/resellerclub";
import { renewDomain as rcRenewDomain } from "@/lib/integrations/resellerclub";
import { AuthService } from "@/lib/auth";
import { createOrder } from "@/lib/services/orders";
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

    // Renew domain via the typed wrapper. Outcomes:
    //   renewed         — happy path, carry through orderId + price
    //   balance_pending — RC queued for ops top-up; surface a clear
    //                     user message, but DON'T return a 500 (the
    //                     renewal will complete asynchronously)
    //   hard_failure    — anything else; user sees generic copy, raw
    //                     reason stays in serverLogger
    const outcome = await rcRenewDomain({ domainName, years });

    if (outcome.kind === "balance_pending") {
      return NextResponse.json(
        {
          error:
            "Renewal is queued — our system is finishing the request. Please check your domain list in a few minutes.",
          status: "pending",
        },
        { status: 202 }
      );
    }
    if (outcome.kind === "hard_failure") {
      return NextResponse.json(
        { error: "Failed to renew domain. Our team has been notified." },
        { status: 500 }
      );
    }

    // outcome.kind === "renewed"
    const renewedPrice = outcome.price ?? 0;
    const renewedOrderId = outcome.orderId;

    // Create order record for renewal
    const order = await createOrder({
      orderId: `RENEW_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      userId: user._id,
      userName: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
      userEmail: user.email,
      paymentId,
      amount: renewedPrice,
      currency: "INR",
      status: "completed",
      domains: [
        {
          domainName,
          price: renewedPrice,
          currency: "INR",
          registrationPeriod: years,
          status: "registered",
          orderId: renewedOrderId,
          expiresAt: new Date(Date.now() + years * 365 * 24 * 60 * 60 * 1000),
        },
      ],
      successfulDomains: [domainName],
    });

    // Update user's domain list
    await appendUserDomain(String(user._id), {
      domainName,
      price: renewedPrice,
      currency: "INR",
      registrationPeriod: years,
      status: "registered",
      orderId: renewedOrderId,
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
