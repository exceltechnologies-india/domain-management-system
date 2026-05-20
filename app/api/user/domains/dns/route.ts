import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import type { IOrder } from "@/models/Order";
import { listDomainsForUser } from "@/lib/services/domains";
import { listOrdersForUser } from "@/lib/services/orders";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    // Check authentication
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get all orders for the user — DNS view flattens domains across every
    // order, so pass limit:0 to disable the default 50-row cap.
    const orders = await listOrdersForUser(String(user._id), { limit: 0 });

    // Extract domains from orders - ONLY REGISTERED domains for DNS management
    const domains = [];
    const domainMap = new Map();

    // Fetch existing Domain documents to get the correct _id for linking
    const domainDocs = await listDomainsForUser(String(user._id));
    const domainIdMap = new Map(domainDocs.map(d => [d.domainName, d._id.toString()]));

    orders.forEach((order) => {
      order.domains.forEach((domain: IOrder['domains'][number]) => {
        const domainKey = domain.domainName;

        // Only include domains with "registered" status for DNS management
        // Exclude pending, processing, failed, and cancelled domains
        if (domain.status !== "registered") {
          return; // Skip non-registered domains
        }

        // Only add if not already processed or if this is a more recent status
        if (
          !domainMap.has(domainKey) ||
          (domain.status === "registered" &&
            domainMap.get(domainKey).status !== "registered")
        ) {
          // Get the actual Domain ID from our map, fallback to constructed ID if missing (shouldn't happen for registered domains)
          const actualDomainId = domainIdMap.get(domainKey) || `${order._id}_${domain.domainName}`;

          domainMap.set(domainKey, {
            id: actualDomainId,
            name: domain.domainName,
            status: domain.status,
            registrationDate: order.createdAt.toISOString().split("T")[0],
            expiryDate: domain.expiresAt
              ? domain.expiresAt.toISOString().split("T")[0]
              : null,
            registrar: "Domain Services",
            nameservers: [], // Will be populated from DNS records if needed
            autoRenew: false,
            bookingStatus: domain.bookingStatus || [],
            orderId: order.orderId,
            resellerClubOrderId: domain.resellerClubOrderId || (order as unknown as { resellerClubOrderId?: string }).resellerClubOrderId,
            resellerClubCustomerId: domain.resellerClubCustomerId,
            resellerClubContactId: domain.resellerClubContactId,
            dnsActivated: domain.dnsActivated || false,
            dnsActivatedAt: domain.dnsActivatedAt,
            dnsProvider: domain.dnsProvider || "resellerclub",
            error: domain.error,
          });
        }
      });
    });

    // Convert map to array
    const domainArray = Array.from(domainMap.values());

    return NextResponse.json({
      success: true,
      domains: domainArray,
      total: domainArray.length,
    });
  } catch (error) {
    serverLogger.error("Error fetching user DNS domains:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
