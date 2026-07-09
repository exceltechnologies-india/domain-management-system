import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { DirectAdminService } from "@/lib/directadmin";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { rateLimiters, rateLimitResponse } from "@/lib/rate-limit";
import { serverLogger } from "@/lib/server-logger";
import type { IHosting } from "@/models/Hosting";
import { listHostingsForUser, listUserHostingsByDomain, upsertHostingFromDirectAdminStats } from "@/lib/services/hostings";

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

    const user = authUser;

    // Per-user rate-limit. The route below can fan out into ~hundreds of
    // DA RPC calls when the email-discovery path runs — capping per-user
    // bounds the DA load any single user can trigger.
    const rl = await rateLimiters.api.checkKey(`stats:${user._id}`);
    if (!rl.allowed) {
      return rateLimitResponse(rl, {
        limit: 100,
        message: "Too many stats requests. Please wait before retrying.",
      });
    }

    // 2. Identification Strategy — OWNERSHIP COMES FROM OUR RECORDS ONLY.
    //
    // ⚠️ SECURITY: never determine hosting ownership from the DirectAdmin
    // account's email. The operator provisions many customers' DA accounts
    // with the same contact email (e.g. the reseller's own address), so an
    // email-match scan over the DA user list returned OTHER customers'
    // accounts — a cross-tenant data leak (a customer saw every account that
    // shared that email). Ownership is authoritatively the set of Hosting
    // docs whose `userId` is this user, plus the user's own linked
    // `directAdminUsername`. We only ever fetch DA stats for those usernames.
    const matchingDaUsernames = new Set<string>();

    if (user.directAdminUsername) {
        matchingDaUsernames.add(user.directAdminUsername);
    }

    // Authoritative ownership: DA usernames on Hosting records this user owns.
    const ownedHostings = await listHostingsForUser(user._id, { limit: 100 });
    for (const h of ownedHostings) {
        const daU = (h as { directAdminUsername?: string }).directAdminUsername;
        if (daU && daU.trim()) matchingDaUsernames.add(daU.trim());
    }

    // Server info (PHP default, etc.). We previously ALSO called
    // getAllUserUsage() here (a full-server usage dump) but its result was
    // never used and it slowed the page as the server grew — dropped.
    const serverInfo = await DirectAdminService.getServerInfo();

    const targetUsernames = Array.from(matchingDaUsernames);

    // Shared helper — surfaces local Hostings in status='pending' without
    // a DA account yet. Called BOTH here (when the user has no linked DA
    // usernames at all — the "fresh manual-flow trial signup" case)
    // AND at the bottom of the DA-derived path (to catch pending Hostings
    // alongside active ones). Was missed on the first pass in
    // dms-00233-sbc — the DA-derived branch got the fix but this early-
    // return branch did not, so a fresh manual-flow trial signup still
    // saw "No Hosting Services" on /dashboard/hosting.
    const fetchPendingHostingEntries = async (
      alreadyListedDomains: Set<string>
    ) => {
      const Hosting = (await import("@/models/Hosting")).default;
      const pendingWithoutDa = await Hosting.find({
        userId: user._id,
        status: "pending",
        $or: [
          { directAdminUsername: "" },
          { directAdminUsername: { $exists: false } },
        ],
      })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean();

      return pendingWithoutDa
        .filter((h) => !alreadyListedDomains.has(h.domainName?.toLowerCase() ?? ""))
        .map((h) => {
          const mandateMode: "tokens" | "subscriptions" | "manual" = h.razorpayTokenId
            ? "tokens"
            : h.billingType === "manual"
              ? "manual"
              : "subscriptions";
          return {
            username: "",
            domain: h.domainName,
            status: "pending" as const,
            hostingId: String(h._id),
            bandwidth: "0",
            quota: "0",
            usedBandwidth: 0,
            usedQuota: 0,
            serverIp: null,
            nameservers: [] as string[],
            phpVersion: null,
            suspended: false,
            package: h.serverPackage || h.planId,
            expires_at: h.expiryDate ?? null,
            createdAt: h.startDate ?? h.createdAt ?? null,
            plan: null,
            isTrial: h.isTrial === true,
            billingType: h.billingType,
            subscriptionId: h.subscriptionId ?? null,
            razorpayCustomerId: h.razorpayCustomerId ?? null,
            razorpayTokenId: h.razorpayTokenId ?? null,
            mandateMode,
          };
        });
    };

    if (targetUsernames.length === 0) {
         const pendingEntries = await fetchPendingHostingEntries(new Set());
         return NextResponse.json({
            success: true,
            data: pendingEntries,
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
                const dnsRecords = await DirectAdminService.getDNSRecords(daUsername, daConfig.domain ?? '');
                const actualNs = dnsRecords
                    .filter((r) => r.type === 'NS')
                    .map((r) => (r.value ?? '').replace(/\.$/, ''))
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
            const hostingRecords = daConfig.domain
              ? await listUserHostingsByDomain(user._id, daConfig.domain)
              : [];

            // Strategy:
            // 1. Match by DA Username (Exact link)
            // 2. Match by Active status (If re-purchased after termination)
            // 3. Fallback to latest
            let hostingRecord = hostingRecords.find((h: IHosting) => h.directAdminUsername === daUsername);
            if (!hostingRecord) {
                hostingRecord = hostingRecords.find((h: IHosting) => h.status === 'active');
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
            // "suspended" isn't in the typed enum yet but DOES exist at runtime; widen the
            // comparison via cast.
            const recordStatus = hostingRecord?.status as unknown as string | undefined;
            if (derivedStatus === 'active' && hostingRecord && (recordStatus === 'suspended' || recordStatus === 'terminated')) {
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

                await upsertHostingFromDirectAdminStats({
                    filter: updateFilter,
                    set: {
                        status: derivedStatus,
                        directAdminUsername: daUsername, // Ensure we link to correct DA user
                        // Update plan details if available
                        ...(daConfig.package ? { planId: daConfig.package } : {}),
                    },
                    setOnInsert: {
                        // Defaults for new records found on DA but missing in DB
                        userId: user._id,
                        domainName: daConfig.domain,
                        orderId: `IMPORTED-${daUsername}`,
                        name: daConfig.package || 'Imported Plan',
                        serverPackage: daConfig.package || 'default',
                        planId: daConfig.package || 'default',
                        startDate: daConfig.date_created ? new Date(daConfig.date_created) : new Date(),
                        // Default expiry to 1 year from now if unknown, to ensure it shows as Active
                        expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
                        autoRenew: false,
                    },
                });
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
              // Derived discriminator: 'tokens' iff a mandate token is on
              // file (Tokens-API flow — strict 1-attempt MIT policy);
              // 'subscriptions' iff a Razorpay subscriptionId is on file
              // (Subscriptions-API flow — Razorpay handles retries
              // server-side); 'manual' otherwise (no auto-renewal at
              // all). The customer dashboard renders a payment-validity
              // note ONLY when this is 'tokens' so the strict-policy
              // expectation is communicated to the customers it applies
              // to, without misleading the others.
              mandateMode: hostingRecord?.razorpayTokenId
                ? 'tokens'
                : hostingRecord?.subscriptionId
                  ? 'subscriptions'
                  : 'manual',
            };

        } catch (error: unknown) {
             serverLogger.error(`Error fetching stats for ${daUsername}`, error);
             return null; // Skip failed
        }
    });

    const results = await Promise.all(accountStatsPromises);
    const validResults = results.filter(r => r !== null);

    // Also fetch pending Hostings without DA accounts (see the
    // fetchPendingHostingEntries helper defined above). Dedupe against
    // domainNames already present in the DA-derived results — narrow
    // race window (~5-15 min) where a provisioned Hosting could appear
    // in both if the cron ran mid-request.
    const alreadyListed = new Set(
      validResults
        .map((r) => (r as { domain?: string }).domain?.toLowerCase())
        .filter((d): d is string => !!d)
    );
    const pendingEntries = await fetchPendingHostingEntries(alreadyListed);

    return secureJsonResponse({
      success: true,
      data: [...validResults, ...pendingEntries],
    });

  } catch (error: unknown) {
    interface NetErr { code?: string; status?: number; message?: string }
    const e = (error && typeof error === 'object' ? error : {}) as NetErr;
    serverLogger.error(`User Hosting Stats Error:`, e.message);

    // Check for common connection errors
    const isConnectionError =
      e.code === 'ECONNREFUSED' ||
      e.code === 'ETIMEDOUT' ||
      e.message?.includes('status code 503') ||
      e.message?.includes('status code 502');

    if (e.status === 503 || e.code === 'DA_SERVER_DOWN' || isConnectionError) {
         return secureErrorResponse("Service Unavailable", 503, "DA_SERVER_DOWN");
    }

    return secureErrorResponse(
      "Failed to fetch hosting details",
      500,
      "STATS_FETCH_FAILED"
    );
  }
}
