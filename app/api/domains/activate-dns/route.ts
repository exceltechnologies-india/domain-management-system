import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { ResellerClubWrapper } from "@/lib/resellerclub-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { findOrderByDomainForUser, findOrderDomain } from "@/lib/services/orders";
import { validatedBody, z } from "@/lib/api-validation";

const userActivateDnsSchema = z.object({
  domainName: z.string().trim().toLowerCase().min(3).max(253),
  force: z.boolean().optional(),
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

    const validation = await validatedBody(request, userActivateDnsSchema);
    if (!validation.ok) return validation.response;
    const { domainName, force } = validation.data;

    const order = await findOrderByDomainForUser(user._id, domainName);

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
    // Top-level fallback is a legacy escape hatch from when Order docs could
    // carry a parent resellerClubOrderId before per-domain fields existed.
    const resellerOrderId = domain.resellerClubOrderId || (order as unknown as { resellerClubOrderId?: string }).resellerClubOrderId;

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
