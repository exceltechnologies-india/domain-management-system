import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { getDomainDetails as rcGetDomainDetails } from "@/lib/integrations/resellerclub";
import { serverLogger } from "@/lib/server-logger";
import { findOrderByDomainForUser, findOrderDomain } from "@/lib/services/orders";
import { validatedBody, z } from "@/lib/api-validation";

const verifyStatusSchema = z.object({
  domainName: z.string().trim().toLowerCase().min(3).max(253),
});

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    // Check authentication
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const validation = await validatedBody(request, verifyStatusSchema);
    if (!validation.ok) return validation.response;
    const { domainName } = validation.data;

    const order = await findOrderByDomainForUser(user._id, domainName);

    if (!order) {
      return NextResponse.json({ error: "Domain not found" }, { status: 404 });
    }

    const domain = findOrderDomain(order, domainName);

    if (!domain || !domain.resellerClubCustomerId) {
      return NextResponse.json(
        { error: "Registrar customer reference not found for this domain. Please contact support." },
        { status: 404 }
      );
    }

    const outcome = await rcGetDomainDetails({ domainName });

    if (outcome.kind === "not_found") {
      return NextResponse.json({
        success: true,
        domainName,
        status: "pending",
        message:
          "Domain not found in ResellerClub - likely pending registration",
        resellerClubStatus: "not_found",
      });
    }

    if (outcome.kind === "hard_failure") {
      return NextResponse.json({
        success: false,
        error: outcome.reason,
      });
    }

    const domainData = outcome.details;
    const isRegistered = domainData.domainstatus === "Active";

    return NextResponse.json({
      success: true,
      domainName,
      status: isRegistered ? "registered" : "pending",
      message: isRegistered
        ? "Domain is registered and active"
        : "Domain found but not yet active",
      resellerClubStatus: domainData.domainstatus || "unknown",
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
