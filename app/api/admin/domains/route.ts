import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import Order from "@/models/Order";
import PendingDomain from "@/models/PendingDomain";
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

    // Connect to database
    await connectDB();

    // 1. Fetch all pending domain names to filter them out of the registered list
    const pendingDomainsList = await PendingDomain.find({}, { domainName: 1 }).lean();
    const pendingNormalizedNames = new Set(
      pendingDomainsList.map((pd: any) => pd.domainName.toLowerCase().trim())
    );

    // 2. Get all orders with domains - use lean() for performance and raw data access
    const orders = await Order.find({})
      .populate("userId", "firstName lastName email phone companyName")
      .sort({ createdAt: -1 })
      .lean();

    // Flatten domains with customer information
    // Only include registered domains for DNS management
    const domainMap = new Map();
    
    for (const order of orders) {
      if (!order.domains || !Array.isArray(order.domains)) continue;

      for (const domain of order.domains) {
        const domainName = (domain.domainName || domain.name || "").toLowerCase().trim();
        
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
        const rcOrderId = domain.resellerClubOrderId || domain.orderId || (order as any).resellerClubOrderId;

        const domainEntry = {
          id: (domain as any)._id?.toString() || `${order._id}_${domainName}`,
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
          customerName: order.userId
            ? `${(order.userId as any).firstName} ${(order.userId as any).lastName}`
            : "Unknown",
          customerEmail: (order.userId as any)?.email || "Unknown",
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
