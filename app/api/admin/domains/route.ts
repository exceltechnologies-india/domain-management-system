import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { listAllOrdersForAdminDomains } from "@/lib/services/orders";
import { listAllPendingDomainNames } from "@/lib/services/pending-domains";
import { serverLogger } from "@/lib/server-logger";
import connectDB from "@/lib/mongodb";
import Domain from "@/models/Domain";

// Force dynamic rendering - required for API routes
export const dynamic = "force-dynamic";

/**
 * DELETE /api/admin/domains?domainName=example.com
 *
 * Admin-only SOFT delete — removes a domain from the customer panel by
 * stamping `deletedAt` (reversible within the 90-day TTL on that field).
 * Intended for domains that are no longer manageable here — e.g. transferred
 * out to a different registrar account, or legacy/test registrations. Does NOT
 * touch the Order (billing/audit trail stays intact) and makes NO registrar
 * call — the domain is already gone from our RC account.
 */
export async function DELETE(request: NextRequest) {
  try {
    const admin = await AuthService.getAdminFromRequest(request);
    if (!admin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const domainName = request.nextUrl.searchParams.get("domainName")?.trim().toLowerCase();
    if (!domainName) {
      return NextResponse.json({ error: "domainName is required" }, { status: 400 });
    }

    await connectDB();
    const res = await Domain.updateOne(
      { domainName, deletedAt: null },
      { $set: { deletedAt: new Date() } }
    );

    if (res.matchedCount === 0) {
      return NextResponse.json(
        { error: "No active domain found with that name (already removed or never existed)." },
        { status: 404 }
      );
    }

    serverLogger.warn(
      `[admin/domains] Soft-deleted domain "${domainName}" from panel (by ${admin.email})`
    );
    return NextResponse.json({
      success: true,
      domainName,
      message: "Domain removed from the panel (soft-deleted, reversible for 90 days).",
    });
  } catch (error) {
    serverLogger.error("[admin/domains] soft-delete error:", error);
    return NextResponse.json({ error: "Failed to remove domain" }, { status: 500 });
  }
}

const MAX_DOMAINS_PAGE_SIZE = 100;

export async function GET(request: NextRequest) {
  try {
    const user = await AuthService.getAdminFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
    const limit = Math.min(MAX_DOMAINS_PAGE_SIZE, Math.max(1, parseInt(searchParams.get("limit") ?? "50", 10)));

    // 1. Fetch all pending domain names to filter them out of the registered list
    const pendingDomainsList = await listAllPendingDomainNames();
    const pendingNormalizedNames = new Set(
      pendingDomainsList.map((pd) => pd.domainName.toLowerCase().trim())
    );

    // 1b. Soft-deleted domains (removed from the panel — e.g. transferred out /
    // legacy test domains). This admin list is order-derived, so a Domain
    // soft-delete wouldn't drop it here without this cross-reference.
    await connectDB();
    const removedDomains = await Domain.find({ deletedAt: { $ne: null } })
      .select("domainName")
      .lean<Array<{ domainName: string }>>();
    const removedNormalizedNames = new Set(
      removedDomains.map((d) => (d.domainName || "").toLowerCase().trim())
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

        // Skip domains removed from the panel (soft-deleted).
        if (removedNormalizedNames.has(domainName)) {
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
