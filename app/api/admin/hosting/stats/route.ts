import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { DirectAdminService } from "@/lib/directadmin";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { addSecurityHeaders } from "@/lib/security-headers";
import { serverLogger } from "@/lib/server-logger";
import User from "@/models/User";
import { findUsersByEmails, listUsersWithDirectAdmin } from "@/lib/services/users";
import Order from "@/models/Order";
import HostingPlan from "@/models/HostingPlan";
import connectDB from "@/lib/mongodb";

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/hosting/stats
 * Fetches hosting stats for all users, syncing with DirectAdmin.
 * Restricted to Admins only.
 */
export async function GET(request: NextRequest) {
  try {
    // 1. Authenticate and check Admin role
    const isAdmin = await AuthService.isAdmin(request);
    if (!isAdmin) {
      return secureErrorResponse("Unauthorized. Admin access required.", 403, "FORBIDDEN");
    }

    await connectDB();
    
    // 2. Fetch Data Sources (Resilient)
    // Always attempt live fetch as the default and only mode
    
    // Local DB Fetch (Should always succeed)
    const localUsersPromise = listUsersWithDirectAdmin();

    const hostingRecordPromise = (async () => {
        try {
           return await (await import("@/models/Hosting")).default.find({}).sort({ createdAt: -1 }).lean();
        } catch (e) { return []; }
    })();

    const [localUsers, hostingRecords] = await Promise.all([localUsersPromise, hostingRecordPromise]);

    // Live DA Fetch (May fail)
    let isDaAvailable = true;
    let daUserList: string[] = [];
    let daUsageMap: any = {};
    let serverInfo: any = { php: 'Unknown' };
    let daError: string | null = null;

    try {
        const daPromise = Promise.all([
            DirectAdminService.listUsers(),
            DirectAdminService.getAllUserUsage(),
            DirectAdminService.getServerInfo().catch(e => ({ php: 'Default' }))
        ]);
        
        // 5 second timeout for live data
        const timeoutPromise = new Promise<any>((_, reject) => 
            setTimeout(() => reject(new Error('DA_TIMEOUT')), 5000)
        );

        const [users, usage, info] = await Promise.race([daPromise, timeoutPromise]);
        
        daUserList = users;
        daUsageMap = usage;
        serverInfo = info;
    } catch (e: any) {
        serverLogger.warn("DA Sync failed or timed out, using DB fallback:", e);
        isDaAvailable = false;
        daError = e.message || 'DirectAdmin server is unreachable or timed out';
        
        if (e.message === 'DA_TIMEOUT') {
            daError = 'Connection attempt to DirectAdmin timed out (5s limit)';
        }
    }

    // 3. Process Data
    let hostingStats: any[] = [];

    if (isDaAvailable) {
        // LIVE MODE: Iterate over DA Users and map to local
        hostingStats = await Promise.all(daUserList.map(async (daUsername) => {
            // [Keep existing mapping logic, just using pre-fetched hostingRecords]
            let localUser = localUsers.find((u: any) => u.directAdminUsername === daUsername);
            let linkedByEmail = false;
            let daConfig: any = {};

            try {
                // We fetch individual config here - this might still be slow if we have 100s of users.
                // TODO: optimization - rely on bulk usage map + DB for most things.
                // For now, we wrap this in try/catch so one user failing doesn't break all.
                daConfig = await DirectAdminService.getUserConfig(daUsername);
                
                if (!localUser && daConfig.email) {
                    // Try simple email match from our pre-fetched list? No, simpler to just skip or rely on what we have.
                    // Doing a DB call here is okay as it's not external.
                    const userByEmail = await User.findOne({ email: daConfig.email }).select('firstName lastName email text hostingCreatedAt hostingExpiresAt').lean();
                    if (userByEmail) {
                        localUser = userByEmail as any;
                        linkedByEmail = true;
                    }
                }
            } catch (e: any) {
                // If specific user fetch fails.
                 return {
                    id: daUsername,
                    daUsername,
                    status: 'error',
                    error: e.message,
                    domain: 'Error fetching',
                    user: { name: 'Unknown', email: 'N/A' },
                    usage: { bandwidth: '0', disk: '0', bandwidthLimit: '0', diskLimit: '0' }
                };
            }

            const bandwidth = daConfig.bandwidth || '0';
            const quota = daConfig.quota || '0';
            
            const usage = {
              bandwidth: daConfig.bandwidth_usage || '0',
              disk: daConfig.quota_usage || '0',
              bandwidthLimit: bandwidth === 'unlimited' ? 'Unlimited' : bandwidth,
              diskLimit: quota === 'unlimited' ? 'Unlimited' : quota,
            };

            let activePhpVersion = 'Default';
             if (daConfig.php_version && daConfig.php_version !== 'Default') {
                activePhpVersion = daConfig.php_version;
            } else if (daConfig.php === 'ON' && serverInfo.php) {
                activePhpVersion = serverInfo.php;
            }

            let expiresAt = null;
            let createdAt = null;

            // Strategy: Pick the best matching local record for THIS domain
            const domainRecords = hostingRecords.filter((h: any) => h.domainName === daConfig.domain);
            
            // 1. Exact Username match
            // 2. Or 'active' status
            // 3. Or just the latest (as list is sorted by createdAt: -1)
            let hostingRecord = domainRecords.find((h: any) => h.directAdminUsername === daUsername);
            if (!hostingRecord) {
                hostingRecord = domainRecords.find((h: any) => h.status === 'active');
            }
            if (!hostingRecord && domainRecords.length > 0) {
                hostingRecord = domainRecords[0];
            }

            if (hostingRecord) {
                expiresAt = hostingRecord.expiryDate;
                createdAt = hostingRecord.startDate || hostingRecord.createdAt;
            } else if (localUser && daUsername === localUser.directAdminUsername) {
                 if (!expiresAt) expiresAt = localUser.hostingExpiresAt;
                 if (!createdAt) createdAt = localUser.hostingCreatedAt;
            }

            let status = daConfig.suspended === 'yes' ? 'suspended' : 'active';

            // CRITICAL FIX: Respect local DB status if it's more specific (suspended/terminated)
            // This ensures Admin Panel matches User Panel and Cron Job results
            if (hostingRecord && (hostingRecord.status === 'suspended' || hostingRecord.status === 'terminated')) {
                // Only override if the record is the one we are actually looking at (linked or active)
                status = hostingRecord.status;
            }

            return {
              id: daUsername,
              dbId: hostingRecord ? (hostingRecord as any)._id.toString() : (localUser ? (localUser as any)._id.toString() : null),
              userId: localUser ? (localUser as any)._id.toString() : null,
              user: localUser ? {
                name: `${localUser.firstName} ${localUser.lastName}`,
                email: localUser.email,
              } : { 
                name: 'Unlinked Account', 
                email: daConfig.email || 'No local account found' 
              },
              domain: daConfig.domain || 'N/A',
              daUsername: daUsername,
              status: status,
              serverIp: daConfig.ip || 'Shared',
              usage,
              package: daConfig.package || 'Unknown',
              phpVersion: activePhpVersion,
              expiryDate: expiresAt,
              createdDate: createdAt || daConfig.date_created,
              isUnlinked: !localUser,
              linkedByEmail: linkedByEmail
            };
        }));
    } else {
        // FALLBACK DB MODE: Iterate over Hosting Records + Users
        // This won't be as complete for "unlinked" users existing only on DA, 
        // but it shows what we know about.
        
        // 1. Map from Hosting Collection (primary source of truth for "active" services we know about)
        const dbStats = hostingRecords.map((h: any) => {
             const localUser = localUsers.find((u: any) => u._id.toString() === h.userId.toString());
             return {
                 id: h._id.toString(),
                 dbId: h._id.toString(),
                 userId: h.userId,
                 user: localUser ? {
                     name: `${localUser.firstName} ${localUser.lastName}`,
                     email: localUser.email,
                 } : { name: 'Unknown User', email: 'N/A' },
                 domain: h.domainName,
                 daUsername: h.username || localUser?.directAdminUsername || 'N/A',
                 status: h.status, // active/suspended/terminated from DB
                 serverIp: h.serverIp || 'Shared',
                 usage: { // We don't have real-time usage in DB usually, unless we sync it periodically.
                     bandwidth: '0', disk: '0', 
                     bandwidthLimit: 'Unknown', diskLimit: 'Unknown' 
                 },
                 package: h.name || 'Unknown',
                 phpVersion: 'Unknown',
                 expiryDate: h.expiryDate,
                 createdDate: h.createdAt,
                 isUnlinked: !localUser, // If we have a hosting record but no user?
                 linkedByEmail: false
             };
        });
        
        hostingStats = dbStats;
    }

    // Determine Mode (Primarily for UI to show where data came from)
    let daMode = 'Live';
    
    if (!isDaAvailable) {
        daMode = 'Disconnected';
    } else {
        const daUrl = process.env.DIRECTADMIN_URL || '';
        if (daUrl.includes('localhost') || daUrl.includes('127.0.0.1') || daUrl.includes('host.docker.internal')) {
            daMode = 'Local';
        }
    }

    const response = NextResponse.json({ 
      success: true, 
      data: hostingStats,
      source: isDaAvailable ? 'live' : 'db',
      isDaConnected: isDaAvailable,
      daError: daError,
      daMode,
      warning: isDaAvailable ? null : `DirectAdmin unreachable: ${daError}`
    });
    
    return addSecurityHeaders(response);

  } catch (error: any) {
    serverLogger.error(`Admin Hosting Stats Error:`, error.message);
    
    // In strict error case, try to return DB data one last time if we haven't already
    try {
        const fallbackHosting = await (await import("@/models/Hosting")).default.find({}).lean();
        const fallbackUsers = await User.find({}).select('firstName lastName email').lean();
        
        const fallbackStats = fallbackHosting.map((h: any) => {
            const u: any = fallbackUsers.find((u: any) => u._id.toString() === h.userId.toString());
            return {
                id: h._id.toString(),
                user: u ? { name: `${u.firstName} ${u.lastName}`, email: u.email } : { name: 'N/A', email: 'N/A'},
                domain: h.domainName,
                status: h.status,
                usage: { bandwidth: '0', disk: '0', bandwidthLimit: '0', diskLimit: '0' },
                package: h.name,
                expiryDate: h.expiryDate,
                createdDate: h.createdAt
            };
        });

        return secureJsonResponse({
            success: true,
            data: fallbackStats,
            source: 'db',
            warning: 'System critical error. Showing cached/fallback data.'
        });

    } catch (e) {
         return secureErrorResponse(
            "Failed to fetch hosting statistics",
            500,
            "STATS_FETCH_FAILED"
        );
    }
  }
}

