import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { listAllOrdersForAdminDomains } from "@/lib/services/orders";
import { listAllPendingDomainNames } from "@/lib/services/pending-domains";
import { serverLogger } from "@/lib/server-logger";

// Force dynamic rendering - required for API routes
export const dynamic = "force-dynamic";

const MAX_DOMAINS_PAGE_SIZE = 100;

export async function GET(request: NextRequest) {
  try {
    // Check authentication
    const user = await AuthService.getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check if user is admin
    if (user.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
    const limit = Math.min(MAX_DOMAINS_PAGE_SIZE, Math.max(1, parseInt(searchParams.get("limit") ?? "50", 10)));

    // 1. Fetch all pending domain names to filter them out of the registered list
    const pendingDomainsList = await listAllPendingDomainNames();
    const pendingNormalizedNames = new Set(
      pendingDomainsList.map((pd) => pd.domainName.toLowerCase().trim())
    );

    // 2. Get all orders with domains — service handles populate + lean
    const orders = await listAllOrdersForAdminDomains();

    // Flatten domains with customer information
    // Only include registered domains for DNS management
    const domainMap = new Map();
    
    for (const order of orders) {
      if (!order.domains || !Array.isArray(order.domains)) continue;

      for (const domain of order.domains) {
        // Legacy rows may have stored the domain name under `name` instead of `domainName`.
        const domainName = (domain.domainName || (domain as unknown as { name?: string }).name || "").toLowerCase().trim();
        
        // CRITICAL FILTER: If this domain is in the PendingDomain collection, 
        // it SHOULD NOT show up in the Registered list, even if status is 'registered'
        if (pendingNormalizedNames.has(domainName)) {
            continue;
        }

        // Filter: Only include items where itemType is "domain"
        // This distinguishes between hostings and domains stored in the same array
        const itemType = domain.itemType || "domain";
        if (itemType !== "domain") {
          continue;
        }

        // Filter: Only include domains with "registered" status
        // Exclude pending, processing, failed, and cancelled domains
        if (domain.status !== "registered") {
          continue;
        }

        // Robust fallback for ResellerClub Order ID
        const orderLoose = order as typeof order & { resellerClubOrderId?: string };
        const rcOrderId = domain.resellerClubOrderId || domain.orderId || orderLoose.resellerClubOrderId;

        // Populated via .populate("userId", ...) so user is the resolved object,
        // not the bare ObjectId.
        const populatedUser = order.userId as unknown as {
          firstName?: string;
          lastName?: string;
          email?: string;
        } | null | undefined;

        // Mongoose subdocuments carry _id; the Order shape's `domains` array
        // element type doesn't declare it, so narrow at the read site.
        const domainWithId = domain as typeof domain & { _id?: { toString(): string } };

        const domainEntry = {
          id: domainWithId._id?.toString() || `${order._id}_${domainName}`,
          name: domainName,
          price: domain.price,
          currency: domain.currency,
          registrationPeriod: domain.registrationPeriod,
          status: domain.status,
          expiresAt: domain.expiresAt,
          resellerClubOrderId: rcOrderId,
          resellerClubCustomerId: domain.resellerClubCustomerId,
          resellerClubContactId: domain.resellerClubContactId,
          dnsActivated: domain.dnsActivated,
          dnsActivatedAt: domain.dnsActivatedAt,
          customerName: populatedUser
            ? `${populatedUser.firstName} ${populatedUser.lastName}`
            : "Unknown",
          customerEmail: populatedUser?.email || "Unknown",
          orderId: order.orderId,
          createdAt: order.createdAt,
        };

        // Deduplication Logic
        if (domainMap.has(domainName)) {
            const existing = domainMap.get(domainName);
            
            // Priority 1: Prefer entry with DNS Activated
            if (domainEntry.dnsActivated && !existing.dnsActivated) {
                domainMap.set(domainName, domainEntry);
            }
            // Priority 2: Prefer entry with ResellerClub Order ID
            else if (domainEntry.resellerClubOrderId && !existing.resellerClubOrderId && existing.dnsActivated === domainEntry.dnsActivated) {
                domainMap.set(domainName, domainEntry);
            }
            // Priority 3: Prefer newer entry (based on creation date)
            else if (new Date(domainEntry.createdAt) > new Date(existing.createdAt) && 
                     existing.dnsActivated === domainEntry.dnsActivated &&
                     !!existing.resellerClubOrderId === !!domainEntry.resellerClubOrderId) {
                domainMap.set(domainName, domainEntry);
            }
        } else {
            domainMap.set(domainName, domainEntry);
        }
      }
    }

    const allDomains = Array.from(domainMap.values());
    const total = allDomains.length;
    const skip = (page - 1) * limit;
    const domains = allDomains.slice(skip, skip + limit);

    return NextResponse.json({
      success: true,
      domains,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: skip + domains.length < total,
      },
    });
  } catch (error) {
    serverLogger.error("Admin domains fetch error:", error);
    return NextResponse.json(
      { error: "Failed to fetch domains" },
      { status: 500 }
    );
  }
}
