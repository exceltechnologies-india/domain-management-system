import { NextRequest, NextResponse } from "next/server";
import { ResellerClubWrapper } from "@/lib/resellerclub-wrapper";
import { ResellerClubAPI } from "@/lib/resellerclub";
import { AuthService } from "@/lib/auth";
import { rateLimiters } from "@/lib/rate-limit";
import connectDB from "@/lib/mongodb";
import Domain from "@/models/Domain";
import { getUserById } from "@/lib/services/users";
import User from "@/models/User";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const rateLimit = await rateLimiters.api.isAllowed(request);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        {
          status: 429,
          headers: {
            "Retry-After": Math.ceil((rateLimit.resetTime - Date.now()) / 1000).toString(),
          },
        }
      );
    }

    // Check authentication
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { domainName, authCode } = await request.json();

    if (!domainName || !authCode) {
      return NextResponse.json(
        { error: "Domain name and Auth Code (EPP) are required" },
        { status: 400 }
      );
    }

    // Connect to database
    await connectDB();

    // Find user details to ensure we have a customer in ResellerClub
    const dbUser = await getUserById(String(user._id));
    if (!dbUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Prepare user data for ResellerClub
    const userData = {
      email: dbUser.email,
      firstName: dbUser.firstName,
      lastName: dbUser.lastName,
      phone: dbUser.phone || "0000000000",
      companyName: dbUser.companyName,
      address: dbUser.address ? {
        line1: dbUser.address.line1 || "Default Address",
        city: dbUser.address.city || "Default City",
        state: dbUser.address.state || "Default State",
        country: dbUser.address.country || "IN",
        zipcode: dbUser.address.zipcode || "000000",
      } : undefined,
    };

    // Get or create ResellerClub customer and contact
    const rcCustomer = await ResellerClubAPI.getOrCreateCustomerAndContact(userData);

    if (rcCustomer.status === "error" || !rcCustomer.customerId || !rcCustomer.contactId) {
      return NextResponse.json(
        { error: rcCustomer.error || "Failed to setup customer profile for transfer" },
        { status: 500 }
      );
    }

    const contacts = {
      admin: rcCustomer.contactId,
      tech: rcCustomer.contactId,
      billing: rcCustomer.contactId
    };

    // Initiate Transfer
    const result = await ResellerClubWrapper.transferDomain(
      domainName,
      authCode,
      rcCustomer.customerId,
      contacts
    );

    if (result.status === "error") {
      return NextResponse.json({ error: result.message }, { status: 500 });
    }

    // Create a pending Domain record for the transfer
    const domainRecord = new Domain({
      domainName: domainName.toLowerCase(),
      status: "pending",
      dnsProvider: "resellerclub",
      price: 0, // Not explicitly defining price here; depends on billing model
      currency: "INR",
      registrationPeriod: 1,
      userId: user._id,
      resellerClubOrderId: result.data?.entityid?.toString() || undefined,
    });

    await domainRecord.save();

    // Update user's domain list
    await User.findByIdAndUpdate(user._id, {
      $push: {
        domains: {
          domainName: domainName.toLowerCase(),
          price: 0,
          currency: "INR",
          registrationPeriod: 1,
          status: "pending",
          orderId: result.data?.entityid?.toString() || undefined,
        },
      },
    });

    return NextResponse.json({
      success: true,
      message: "Domain transfer initiated successfully",
      domainName,
    });
  } catch (error) {
    serverLogger.error("Domain transfer error:", error);
    return NextResponse.json(
      { error: "Failed to initiate domain transfer" },
      { status: 500 }
    );
  }
}
