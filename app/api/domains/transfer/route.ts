import { NextRequest, NextResponse } from "next/server";
import { ResellerClubAPI } from "@/lib/resellerclub";
import { transferDomain as rcTransferDomain } from "@/lib/integrations/resellerclub";
import { AuthService } from "@/lib/auth";
import { rateLimiters, rateLimitResponse } from "@/lib/rate-limit";
import connectDB from "@/lib/mongodb";
import Domain from "@/models/Domain";
import { appendUserDomain, getUserById } from "@/lib/services/users";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const rateLimit = await rateLimiters.api.isAllowed(request);
    if (!rateLimit.allowed) {
      return rateLimitResponse(rateLimit, {
        limit: 100,
        message: "Too many requests. Please try again later.",
      });
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

    // Initiate Transfer via the typed wrapper. Branches:
    //   transfer_initiated → happy path; entityId is the RC tracking id
    //   balance_pending   → 202 "queued" (auto-resolves when ops tops up)
    //   transfer_rejected → 400 with a clearer "rejected by registry"
    //                       copy than the previous generic error
    //   hard_failure      → 500 with generic copy
    const outcome = await rcTransferDomain({
      domainName,
      authCode,
      customerId: rcCustomer.customerId,
      contacts,
    });

    if (outcome.kind === "balance_pending") {
      return NextResponse.json(
        {
          error:
            "Transfer is queued — our system is finishing the request. You'll see it in your domain list once it starts.",
          status: "pending",
        },
        { status: 202 }
      );
    }
    if (outcome.kind === "transfer_rejected") {
      return NextResponse.json(
        {
          error:
            "The registry rejected this transfer. Check that the EPP/auth code is correct, the domain is unlocked, and it's older than 60 days.",
        },
        { status: 400 }
      );
    }
    if (outcome.kind === "hard_failure") {
      return NextResponse.json(
        { error: "Failed to initiate domain transfer. Our team has been notified." },
        { status: 500 }
      );
    }

    // outcome.kind === "transfer_initiated"
    const entityId = outcome.entityId;

    // Create a pending Domain record for the transfer
    const domainRecord = new Domain({
      domainName: domainName.toLowerCase(),
      status: "pending",
      dnsProvider: "resellerclub",
      price: 0, // Not explicitly defining price here; depends on billing model
      currency: "INR",
      registrationPeriod: 1,
      userId: user._id,
      resellerClubOrderId: entityId,
    });

    await domainRecord.save();

    // Update user's domain list
    await appendUserDomain(String(user._id), {
      domainName: domainName.toLowerCase(),
      price: 0,
      currency: "INR",
      registrationPeriod: 1,
      status: "pending",
      orderId: entityId,
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
