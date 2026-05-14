import { AUTH_SECRET } from "@/lib/auth-secret";
import { NextRequest, NextResponse } from "next/server";
import { secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import connectDB from "@/lib/mongodb";
import User from "@/models/User";
import Order from "@/models/Order";
import Domain from "@/models/Domain";
import PendingDomain from "@/models/PendingDomain";
import Hosting from "@/models/Hosting";
import { AuthService } from "@/lib/auth";
import { DirectAdminService } from "@/lib/directadmin";
import { getToken } from "next-auth/jwt";
import { formatDateIN } from "@/lib/dateUtils";

// Force dynamic rendering - required for API routes
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {


  try {
    await connectDB();

    // Try to get user from JWT token first
    let user = await AuthService.getUserFromRequest(request);
    
    if (!user) {
      serverLogger.warn("[DashboardAPI] AuthService.getUserFromRequest returned null. Trying direct getToken with cookie fallback.");
      
      // Try NextAuth session via getToken with middleware-aligned config
      // Middleware explicitly sets cookieName, so we should try that too
      const secret = AUTH_SECRET;
      
      const token = await getToken({ 
        req: request,
        secret,
        cookieName: "next-auth.session-token", // Try non-secure name just in case
      }) || await getToken({ 
        req: request,
        secret,
        // Default behavior (tries __Secure- prefix in prod)
      });
      
      if (token?.id) {
        // Get user by id from NextAuth token
        user = await User.findById(token.id).select("-password");
        
        if (!user || !user.isActive) {
          serverLogger.warn(`[DashboardAPI] User found in token but invalid in DB. ID: ${token.id}`);
          return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED_USER_INVALID");
        }
      } else {
        serverLogger.warn("[DashboardAPI] getToken failed to find valid token.");
      }
    }
    
    if (!user) {
      serverLogger.error("[DashboardAPI] Authentication failed. No user found.");
      return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
    }

    // Get user's orders, domains, and hosting
    const [orders, domains, pendingDomainsRaw, hostings] = await Promise.all([
      Order.find({ userId: user._id, isDeleted: { $ne: true } }).sort({ createdAt: -1 }),
      Domain.find({ userId: user._id }).sort({ createdAt: -1 }),
      PendingDomain.find({ userId: user._id, isArchived: { $ne: true } }).sort({ createdAt: -1 }),
      Hosting.find({ userId: user._id }).sort({ createdAt: -1 })
    ]);
    
    // --- Synchronization Logic Start ---
    // Rate-limited: only dispatch if no hosting has been synced in the last 5 minutes.
    // Eliminates duplicate Cloud Tasks jobs on rapid dashboard refreshes.
    const SYNC_COOLDOWN_MS = 5 * 60 * 1000;
    const now = Date.now();
    const needsSync = hostings.length > 0 && hostings.some(
      h => !h.lastSyncedAt || (now - h.lastSyncedAt.getTime()) > SYNC_COOLDOWN_MS
    );

    if (needsSync) {
      try {
        const { createHttpTask } = await import("@/lib/cloud-tasks");
        const queueName = process.env.GCP_QUEUE_NAME || 'default';
        const workerUrl = `${process.env.NEXTAUTH_URL}/api/workers/sync-hosting-status`;

        await createHttpTask(queueName, workerUrl, { userId: user._id });

        // Stamp all hostings so the next visit within 5 min skips the dispatch
        await Hosting.updateMany({ userId: user._id }, { $set: { lastSyncedAt: new Date() } });

        serverLogger.info(`[DashboardAPI] Queued background sync for user ${user._id}`);
      } catch (e: any) {
        serverLogger.error(`[DashboardAPI] Failed to queue sync task: ${e.message}`);
      }
    }
    // --- Synchronization Logic End ---

    // Calculate dashboard statistics
    // Filter hosting to only show those linked to the current user's active DA account
    // Filter hosting to only show those linked to the current user's active DA account
    // Relying on userId from the initial find query is sufficient and safer
    const userHostings = hostings || [];
    const totalDomains = domains.length + pendingDomainsRaw.length;
    const activeDomains = domains.filter(d => d.status === "registered").length;
    const pendingDomainsCount = pendingDomainsRaw.length;
    
    // Calculate total spent from orders (Financial source of truth)
    const totalSpent = orders.reduce((sum, order) => sum + order.amount, 0);

    // Get recent orders
    const recentOrders = orders.slice(0, 5).map((order) => ({
      orderId: order.orderId,
      domains: order.domains.length,
      amount: order.amount,
      status: order.status,
      date: formatDateIN(order.createdAt),
    }));

    // Get recent services (Domains + Hosting)
    // Combine and sort by creation date
    const allServices = [
      ...domains.map(d => ({
        name: d.domainName,
        status: d.status,
        itemType: 'domain',
        registeredDate: d.registeredAt || d.createdAt,
        expiryDate: d.expiresAt
      })),
      ...pendingDomainsRaw.map(pd => ({
        name: pd.domainName,
        status: pd.status || 'pending',
        itemType: 'domain',
        registeredDate: pd.createdAt,
        expiryDate: pd.expiresAt
      })),
      ...userHostings.map(h => ({
        name: h.domainName,
        status: h.status,
        itemType: 'hosting',
        registeredDate: h.startDate || h.createdAt,
        expiryDate: h.expiryDate
      }))
    ]
    .filter(service => service.status !== 'terminated') // Filter out terminated services
    .sort((a, b) => new Date(b.registeredDate).getTime() - new Date(a.registeredDate).getTime())
    .slice(0, 5);

    const recentDomains = allServices.map(service => ({
       name: service.name,
       status: service.status,
       itemType: service.itemType,
       registeredDate: formatDateIN(service.registeredDate),
       expiryDate: service.expiryDate ? formatDateIN(service.expiryDate) : "N/A"
    }));

    // Get upcoming renewals (domains expiring in next 30 days)
    // We can also include hosting renewals here
    const upcomingRenewals = [
      ...domains.filter(d => d.status === "registered" && d.expiresAt).map(d => ({ name: d.domainName, expiry: d.expiresAt, type: 'Domain' })),
      ...userHostings.filter(h => h.status === "active" && h.expiryDate).map(h => ({ name: h.domainName, expiry: h.expiryDate, type: 'Hosting' }))
    ]
    .map(item => {
       const daysLeft = Math.ceil((new Date(item.expiry).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
       return {
         domain: item.name, // Frontend expects 'domain' key
         expiryDate: formatDateIN(item.expiry),
         daysLeft,
         type: item.type
       };
    })
    .filter(r => r.daysLeft <= 30 && r.daysLeft > 0)
    .sort((a, b) => a.daysLeft - b.daysLeft)
    .slice(0, 5);

    const dashboardData = {
      stats: {
        totalDomains,
        activeDomains,
        pendingDomains: pendingDomainsCount,
        totalOrders: orders.length,
        recentOrders,
        recentDomains,
        upcomingRenewals,
        activeHostings: Array.from(
          userHostings
            .filter(h => h.status === 'active') // Show all active hostings regardless of expiry
            .reduce((map, h) => {
              // Deduplicate by domain name: only keep the first occurrence
              if (!map.has(h.domainName)) {
                map.set(h.domainName, {
                  id: h._id,
                  domain: h.domainName,
                  package: h.name,
                  status: h.status,
                  expiryDate: h.expiryDate ? formatDateIN(h.expiryDate) : "N/A"
                });
              }
              return map;
            }, new Map())
            .values()
        ),
      },
      serviceStatus: {
        hasDomains: domains.length > 0,
        hasHosting: userHostings.length > 0
      }
    };



// ... existing code ...

    return NextResponse.json(dashboardData);
  } catch (error: any) {
    return secureErrorResponse(
      "Failed to load dashboard data",
      500,
      "DASHBOARD_LOAD_FAILED",
      error // Pass original error object for internal logging
    );
  }
}
