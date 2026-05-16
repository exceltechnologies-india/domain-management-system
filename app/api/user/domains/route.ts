import { AUTH_SECRET } from "@/lib/auth-secret";
import { NextRequest, NextResponse } from "next/server";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import { listDomainsForUser } from "@/lib/services/domains";
import { listActivePendingDomainsForUser } from "@/lib/services/pending-domains";
import Order from "@/models/Order";
import { getUserByIdSafe } from "@/lib/services/users";
import { getToken } from "next-auth/jwt";
import { isHostingItem } from "@/lib/billing";

// Force dynamic rendering - required for API routes
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    
    // Try to get user from JWT token first
    let user = await AuthService.getUserFromRequest(request);
    
    // If no user from JWT, try NextAuth session via getToken (works with cookies)
    if (!user) {
      const token = await getToken({ 
        req: request,
        secret: AUTH_SECRET,
      });
      
      if (token?.id) {
        // Get user by id from NextAuth token
        user = await getUserByIdSafe(token.id);
        
        if (!user || !user.isActive) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
      }
    }
    
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Use a Map to de-duplicate domains by name (case-insensitive)
    // Priority: Domain collection > PendingDomain collection > Order collection
    const domainMap = new Map();

    // 1. Fetch recent successful orders to find domains in process
    const recentOrders = await Order.find({
      userId: user._id,
      status: "completed", // Payment succeeded
      createdAt: { $gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) } // Last 14 days
    }).sort({ createdAt: 1 }); // Process oldest first so newest wins if duplicates in orders

    recentOrders.forEach(order => {
      if (order.isDeleted) return; // Skip deleted orders
      
      if (order.domains && Array.isArray(order.domains)) {
        order.domains.forEach((d: any) => {
          // Skip hosting items using robust identification
          if (d.itemType === 'hosting' || isHostingItem(d)) return;
          
          // Skip failed or cancelled registrations 
          if (['failed', 'cancelled'].includes(d.status)) return;
          
          const domainName = (d.domainName || "").toLowerCase().trim();
          if (!domainName) return;

          domainMap.set(domainName, {
            id: `order-${order._id}-${domainName}`,
            name: d.domainName,
            status: d.status || "pending",
            registrationDate: order.createdAt,
            expiryDate: null,
            registrar: "Processing...",
            nameservers: [],
            autoRenew: false,
            orderId: order.orderId,
            isFromOrder: true
          });
        });
      }
    });

    // 2. Fetch from PendingDomain collection (domains that hit technical issues)
    const pendingDomains = await listActivePendingDomainsForUser(String(user._id));

    pendingDomains.forEach(pd => {
      const domainName = (pd.domainName || "").toLowerCase().trim();
      if (!domainName) return;

      domainMap.set(domainName, {
        id: pd._id.toString(),
        name: pd.domainName,
        status: pd.status || "pending",
        registrationDate: pd.createdAt,
        expiryDate: pd.expiresAt || null,
        registrar: "Manual Review",
        nameservers: pd.nameServers || [],
        autoRenew: false,
        orderId: pd.orderId,
        isFromPending: true
      });
    });

    // 3. Fetch from Domain collection (active/fully registered domains)
    const activeDomains = await listDomainsForUser(String(user._id));

    activeDomains.forEach(domain => {
      const domainName = (domain.domainName || "").toLowerCase().trim();
      if (!domainName) return;

      domainMap.set(domainName, {
        id: domain._id,
        name: domain.domainName,
        status: domain.status,
        registrationDate: domain.registeredAt || null,
        expiryDate: domain.expiresAt || null,
        registrar: "Domain Services",
        nameservers: domain.nameservers || [],
        autoRenew: domain.autoRenew || false,
        orderId: domain.orderId,
        resellerClubOrderId: domain.resellerClubOrderId,
        dnsProvider: domain.dnsProvider || "resellerclub",
        privacyProtection: domain.privacyProtection || false,
        isFromDomain: true
      });
    });

    // Convert map to sorted array
    const domainArray = Array.from(domainMap.values())
      .sort((a, b) => {
        const dateA = a.registrationDate ? new Date(a.registrationDate).getTime() : 0;
        const dateB = b.registrationDate ? new Date(b.registrationDate).getTime() : 0;
        return dateB - dateA; // Newest first
      });

    // Optional pagination — omitting limit returns all (backward-compatible)
    const { searchParams } = new URL(request.url);
    const limitParam = parseInt(searchParams.get("limit") || "0");
    const pageParam = Math.max(1, parseInt(searchParams.get("page") || "1"));
    const statusFilter = searchParams.get("status");

    const filtered = statusFilter
      ? domainArray.filter((d) => d.status === statusFilter)
      : domainArray;

    const total = filtered.length;
    const paginated = limitParam > 0
      ? filtered.slice((pageParam - 1) * limitParam, pageParam * limitParam)
      : filtered;

    return secureJsonResponse({
      success: true,
      domains: paginated,
      total,
      ...(limitParam > 0 && {
        page: pageParam,
        limit: limitParam,
        hasMore: pageParam * limitParam < total,
      }),
    });
  } catch (error: any) {
    return secureErrorResponse(
      "Failed to fetch user domains",
      500,
      "DOMAINS_FETCH_FAILED",
      error
    );
  }
}
