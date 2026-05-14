import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { DirectAdminService } from "@/lib/directadmin";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import Hosting from "@/models/Hosting";
import connectDB from "@/lib/mongodb";

export const dynamic = 'force-dynamic';

/**
 * GET /api/user/hosting/stats
 * Fetches hosting stats for the authenticated user.
 * Returns an ARRAY of accounts (Primary + Email matched).
 */
export async function GET(request: NextRequest) {
  try {
    // 1. Authenticate
    const authUser = await AuthService.getUserFromRequest(request);
    if (!authUser) {
      return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
    }

    await connectDB();

    const user = authUser;

    // 2. Identification Strategy
    // We want to find ALL accounts that belong to this user.
    // Source A: Explicitly linked username (user.directAdminUsername)
    // Source B: Accounts on DA with matching email (user.email)
    
    // Fetch Global Lists once to scan
    const [daUserList, daUsageMap, serverInfo] = await Promise.all([
        DirectAdminService.listUsers(),
        DirectAdminService.getAllUserUsage(),
        DirectAdminService.getServerInfo()
    ]);

    const matchingDaUsernames = new Set<string>();

    // Add Primary Linked Account
    if (user.directAdminUsername) {
        matchingDaUsernames.add(user.directAdminUsername);
    }

    // Scan for Email Matches (if email exists)
    if (user.email) {
        // We fetch config for ALL users in parallel to find email matches.
        // This effectively "discovers" unlinked accounts.
        
        const scanPromises = daUserList.map(async (username) => {
             // Skip if already matched
             if (matchingDaUsernames.has(username)) return;

             try {
                 // Optimization: In a huge system this would be slow.
                 // Ideally we'd have a backend job syncing this.
                 const conf = await DirectAdminService.getUserConfig(username);
                 if (conf && conf.email === user.email) {
                     matchingDaUsernames.add(username);
                 }
             } catch (e) {
                 // Ignore errors
             }
        });
        
        await Promise.all(scanPromises);
    }

    const targetUsernames = Array.from(matchingDaUsernames);
    
    if (targetUsernames.length === 0) {
         return NextResponse.json({ 
            success: true, 
            data: [] // Empty array
          });
    }

    // 3. Fetch Details for Target Accounts
    // Help resolve limit strings
    const resolveLimit = (val: string | undefined, fallback: string = '0') => {
        if (!val) return fallback;
        if (val.toLowerCase() === 'unlimited') return 'Unlimited';
        return val;
    };

    const accountStatsPromises = targetUsernames.map(async (daUsername) => {
        try {
            const daConfig = await DirectAdminService.getUserConfig(daUsername);
            const daUsage = await DirectAdminService.getUserUsage(daUsername);

            const bandwidthLimit = daConfig.bandwidth || '0';
            const quotaLimit = daConfig.quota || '0';

             // Nameservers
            let nameservers = DirectAdminService.NAMESERVERS;
            try {
                const dnsRecords = await DirectAdminService.getDNSRecords(daUsername, daConfig.domain);
                const actualNs = dnsRecords
                    .filter((r: any) => r.type === 'NS')
                    .map((r: any) => r.value.replace(/\.$/, ''))
                    .filter((ns: string) => ns !== daConfig.domain && ns !== `${daConfig.domain}.`);
                const uniqueNs = Array.from(new Set(actualNs));
                if (uniqueNs.length > 0) nameservers = uniqueNs as string[];
            } catch (e) {}

            // PHP
            let activePhpVersion = 'Default';
            if (daConfig.php_version && daConfig.php_version !== 'Default') {
                activePhpVersion = daConfig.php_version;
            } else if (daConfig.php1_select) {
                activePhpVersion = daConfig.php1_select;
            } else if (daConfig.php === 'ON' && serverInfo.php) {
                activePhpVersion = serverInfo.php;
            }

            // Dates & Plan
            let expiresAt = null;
            let createdAt = null;

            // 1. Find the best matching local record for THIS domain
            const hostingRecords = await Hosting.find({
                userId: user._id,
                domainName: daConfig.domain
            }).sort({ createdAt: -1 }); // Newest first

            // Strategy:
            // 1. Match by DA Username (Exact link)
            // 2. Match by Active status (If re-purchased after termination)
            // 3. Fallback to latest
            let hostingRecord = hostingRecords.find((h: any) => h.directAdminUsername === daUsername);
            if (!hostingRecord) {
                hostingRecord = hostingRecords.find((h: any) => h.status === 'active');
            }
            if (!hostingRecord && hostingRecords.length > 0) {
                hostingRecord = hostingRecords[0];
            }

            if (hostingRecord) {
                expiresAt = hostingRecord.expiryDate;
                createdAt = hostingRecord.startDate || hostingRecord.createdAt;
            }

            // 2. Fallbacks for Primary Account (Legacy User fields)
            if (daUsername === user.directAdminUsername) {
                if (!expiresAt) expiresAt = user.hostingExpiresAt;
                if (!createdAt) createdAt = user.hostingCreatedAt;
            }

            // 3. Fallback to DA Creation Date
            if (!createdAt) createdAt = daConfig.date_created || null;

            // Fetch plan details
            let planDetails = null;
            if (daConfig.package) {
              try {
                const HostingPlan = (await import("@/models/HostingPlan")).default;
                planDetails = await HostingPlan.findOne({ planId: daConfig.package }).select('name description features price currency');
              } catch (e) {}
            }

            // Sync logic: Update local DB if status mismatch
            let derivedStatus = daConfig.suspended === 'yes' ? 'suspended' : 'active';
            
            // 4. Expiry Check (Logic consistent with Admin Panel labels, internally suspended)
            // If it's active but past expiry date, mark as suspended (User sees SUSPENDED)
            if (derivedStatus === 'active' && expiresAt && new Date(expiresAt) < new Date()) {
                derivedStatus = 'suspended';
            }

            // CRITICAL FIX: Do not auto-unsuspend if local DB indicates suspension/termination
            // This prevents "Active" status from DA overriding "Suspended" status from Billing/Expiry
            if (derivedStatus === 'active' && hostingRecord && (hostingRecord.status === 'suspended' || hostingRecord.status === 'terminated')) {
                 // ONLY override if this record is indeed the one we are looking at (linked by username)
                 if (hostingRecord.directAdminUsername === daUsername) {
                    derivedStatus = hostingRecord.status;
                 }
            }

            // Standardize output status for the 3-term constraint (Active | Pending | Suspended)
            // Internally 'terminated' or any other non-active/non-pending becomes 'suspended' for the UI
            if (derivedStatus !== 'active' && derivedStatus !== 'pending') {
                derivedStatus = 'suspended';
            }

            try {
                // Determine filter for update:
                // If we found a record, update BY ID to be safe
                // If not, use domain match (will trigger upsert)
                const updateFilter = hostingRecord 
                    ? { _id: hostingRecord._id }
                    : { userId: user._id, domainName: daConfig.domain };

                await Hosting.updateOne(
                    updateFilter,
                    {
                        $set: {
                            status: derivedStatus,
                            directAdminUsername: daUsername, // Ensure we link to correct DA user
                            // Update plan details if available
                            ...(daConfig.package ? { planId: daConfig.package } : {})
                        },
                        $setOnInsert: {
                            // Defaults for new records found on DA but missing in DB
                            userId: user._id,
                            domainName: daConfig.domain,
                            orderId: `IMPORTED-${daUsername}`,
                            name: daConfig.package || 'Imported Plan',
                            serverPackage: daConfig.package || 'default',
                            planId: daConfig.package || 'default',
                            startDate: daConfig.date_created ? new Date(daConfig.date_created) : new Date(),
                            // Default expiry to 1 year from now if unknown, to ensure it shows as Active
                            expiryDate: new Date(Date.now() + 365*24*60*60*1000), 
                            autoRenew: false
                        }
                    },
                    { upsert: true }
                );
            } catch (syncErr) {
                serverLogger.error(`Error syncing local DB for ${daConfig.domain}`, syncErr);
            }

            return {
              domain: daConfig.domain,
              username: daUsername,
              status: derivedStatus,
              ip: daConfig.ip,
              nameservers: nameservers,
              expires_at: expiresAt, // null if unknown
              created_at: createdAt,

              usage: {
                bandwidth_used: daUsage.bandwidth || '0',
                bandwidth_limit: resolveLimit(bandwidthLimit),
                disk_used: daUsage.quota || '0',
                disk_limit: resolveLimit(quotaLimit),
                databases: {
                    used: daUsage.nmysql || daUsage.mysql || '0',
                    limit: resolveLimit(daConfig.mysql)
                },
                emails: {
                    used: daUsage.nemails || '0',
                    limit: resolveLimit(daConfig.nemails)
                },
                ftp: {
                    used: (parseInt(daUsage.nftp || daUsage.ftp || '0')).toString(),
                    limit: resolveLimit(daConfig.ftp)
                },
                subdomains: {
                    used: daUsage.nsubdomains || '0',
                    limit: resolveLimit(daConfig.nsubdomains)
                }
              },
              features: {
                ssl: daConfig.ssl === 'ON',
                cgi: daConfig.cgi === 'ON',
                php: daConfig.php === 'ON',
                spam: daConfig.spam === 'ON'
              },
              package: daConfig.package,
              planDetails: planDetails,
              php: activePhpVersion,
              isPrimary: daUsername === user.directAdminUsername,
              hostingId: hostingRecord?._id?.toString() ?? null,
              autoRenew: hostingRecord?.autoRenew ?? false,
              billingType: hostingRecord?.billingType ?? 'manual',
              isTrial: hostingRecord?.isTrial ?? false,
            };

        } catch (error: any) {
             serverLogger.error(`Error fetching stats for ${daUsername}`, error);
             return null; // Skip failed
        }
    });

    const results = await Promise.all(accountStatsPromises);
    const validResults = results.filter(r => r !== null);

    return secureJsonResponse({ 
      success: true, 
      data: validResults // Returns Array
    });

  } catch (error: any) {
    serverLogger.error(`User Hosting Stats Error:`, error.message);
    
    // Check for common connection errors
    const isConnectionError = 
      error.code === 'ECONNREFUSED' || 
      error.code === 'ETIMEDOUT' || 
      error.message?.includes('status code 503') ||
      error.message?.includes('status code 502');

    if (error.status === 503 || error.code === 'DA_SERVER_DOWN' || isConnectionError) {
         return secureErrorResponse("Service Unavailable", 503, "DA_SERVER_DOWN");
    }

    return secureErrorResponse(
      "Failed to fetch hosting details",
      500,
      "STATS_FETCH_FAILED"
    );
  }
}
