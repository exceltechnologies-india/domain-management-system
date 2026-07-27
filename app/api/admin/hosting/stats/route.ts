import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { DirectAdminService } from "@/lib/directadmin";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { addSecurityHeaders } from "@/lib/security-headers";
import { serverLogger } from "@/lib/server-logger";
import {
  findUsersByEmails,
  getUserBriefByEmail,
  listAllUserBriefs,
  listUsersWithDirectAdmin,
} from "@/lib/services/users";
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

    /**
     * `?firstPage=N` (default 0 = "fetch all") — when set, returns just
     * the first N DA users' rows so the admin page's initial paint is
     * fast even with a 3-digit account count. The page then fires a
     * second request without this param to backfill the rest. With it
     * off (the legacy path), the route fetches DA config + usage for
     * every account, which is 2 DA API calls × N users; even running
     * in parallel the wall-clock grows with N.
     *
     * Cap at 200 to prevent abuse. The list is sliced AFTER DA's
     * listUsers() returns (alphabetical / DA's natural order), so the
     * "first 10" the fast call returns are stable — when the
     * background fetch completes and replaces state, the same 10 rows
     * stay put and 21 more append.
     */
    const firstPageParam = Math.max(0, Math.min(200, Number(new URL(request.url).searchParams.get('firstPage')) || 0));

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
    type DaUserConfig = Record<string, string | undefined>;
    let isDaAvailable = true;
    let daUserList: string[] = [];
    let serverInfo: DaUserConfig = { php: 'Unknown' };
    let daError: string | null = null;

    try {
        // Perf: dropped the upfront `getAllUserUsage()` call — the result
        // was assigned to `daUsageMap` and then never read (the per-user
        // `getUserUsage(daUsername)` call in the row loop below already
        // fetches the same data, and that's the version we actually use).
        // `CMD_API_SHOW_ALL_USER_USAGE` costs 1-3s of DA-side work each
        // request; killing it here shaves that off the fast-paint path
        // without changing any downstream behavior.
        type DaSyncTuple = [string[], DaUserConfig];

        // 10s per-attempt timeout + one silent retry on transient failure.
        // Was 5s single-shot pre-2026-07-03 which fired too aggressively:
        // legitimate cold-DA-connection re-auths, DA license-server
        // round-trips, or brief cross-continent network hiccups pushed
        // wall-time past 5s occasionally + surfaced as "Disconnected"
        // banners to the operator even though DA came back fine on the
        // next refresh. 10s + retry covers the "was going to succeed
        // eventually" majority without letting a genuinely-down DA hold
        // the whole page for 15s+. Total worst-case: 10s + 500ms backoff
        // + 10s = ~20.5s before falling back to DB-only mode.
        const DA_UPFRONT_TIMEOUT_MS = 10_000;
        const DA_RETRY_BACKOFF_MS = 500;

        const attemptDaSync = (): Promise<DaSyncTuple> => {
            const daPromise: Promise<DaSyncTuple> = Promise.all([
                DirectAdminService.listUsers(),
                DirectAdminService.getServerInfo().catch(() => ({ php: 'Default' } as DaUserConfig))
            ]);
            const timeoutPromise = new Promise<DaSyncTuple>((_, reject) =>
                setTimeout(() => reject(new Error('DA_TIMEOUT')), DA_UPFRONT_TIMEOUT_MS)
            );
            return Promise.race([daPromise, timeoutPromise]);
        };

        let users: string[];
        let info: DaUserConfig;
        try {
            [users, info] = await attemptDaSync();
        } catch (firstErr: unknown) {
            const firstMessage = firstErr instanceof Error ? firstErr.message : String(firstErr);
            serverLogger.warn(
                `[ADMIN-HOSTING-STATS] DA upfront call failed on attempt 1 (${firstMessage}) — retrying once after ${DA_RETRY_BACKOFF_MS}ms`
            );
            await new Promise((r) => setTimeout(r, DA_RETRY_BACKOFF_MS));
            // Second attempt gets its own fresh timeout budget. If this
            // also fails, the outer catch takes over and surfaces
            // DA-down to the frontend.
            [users, info] = await attemptDaSync();
            serverLogger.info(
                `[ADMIN-HOSTING-STATS] DA upfront call succeeded on retry (attempt 2)`
            );
        }

        daUserList = users;
        serverInfo = info;
    } catch (e: unknown) {
        serverLogger.warn("DA Sync failed or timed out after retry, using DB fallback:", e);
        isDaAvailable = false;
        const message = e instanceof Error ? e.message : String(e);
        daError = message || 'DirectAdmin server is unreachable or timed out';

        if (message === 'DA_TIMEOUT') {
            daError = 'DirectAdmin timed out after 2 attempts (10s each). Server may be under load — click Refresh to retry.';
        }
    }

    // 3. Process Data
    type HostingStatRow = {
      id: string;
      dbId?: string | null;
      userId?: string | null;
      user: { name: string; email: string };
      domain: string;
      daUsername: string;
      status: string;
      serverIp?: string;
      usage: {
        bandwidth: string;
        disk: string;
        bandwidthLimit: string;
        diskLimit: string;
      };
      package: string;
      phpVersion: string;
      expiryDate?: Date | string | null;
      createdDate?: Date | string | null;
      isUnlinked?: boolean;
      linkedByEmail?: boolean;
      error?: string;
      // Tokens-flow + Subscriptions-flow recurring-billing metadata —
      // surfaced in the admin detail modal so an operator can tell
      // immediately which Razorpay API path runs this Hosting + has
      // the customer/token IDs to pivot into Razorpay's dashboard.
      subscriptionId?: string | null;
      razorpayCustomerId?: string | null;
      razorpayTokenId?: string | null;
      isTrial?: boolean;
      billingType?: string | null;
    };
    type LocalUser = (typeof localUsers)[number] & { _id: { toString(): string } };
    type HostingRecord = {
      _id: { toString(): string };
      domainName: string;
      directAdminUsername?: string;
      status: string;
      startDate?: Date;
      createdAt?: Date;
      expiryDate?: Date;
      userId: { toString(): string };
      username?: string;
      name?: string;
      serverIp?: string;
      subscriptionId?: string | null;
      razorpayCustomerId?: string | null;
      razorpayTokenId?: string | null;
      isTrial?: boolean;
      billingType?: string | null;
      lastProvisionError?: string;
    };
    let hostingStats: HostingStatRow[] = [];

    // Apply the firstPage cap if requested. `totalUsers` reflects the
    // un-sliced count so the frontend knows whether a background fetch
    // is needed to populate the rest.
    const totalUsers = daUserList.length;
    const usersToProcess = firstPageParam > 0
      ? daUserList.slice(0, firstPageParam)
      : daUserList;
    const truncated = usersToProcess.length < totalUsers;

    if (isDaAvailable) {
        // LIVE MODE: Iterate over DA Users and map to local
        hostingStats = await Promise.all(usersToProcess.map(async (daUsername): Promise<HostingStatRow> => {
            // [Keep existing mapping logic, just using pre-fetched hostingRecords]
            let localUser: LocalUser | undefined = (localUsers as LocalUser[]).find(
              (u) => u.directAdminUsername === daUsername
            );
            let linkedByEmail = false;
            let daConfig: DaUserConfig = {};
            // Live disk/bandwidth USAGE values — come from a separate DA
            // endpoint (CMD_API_SHOW_USER_USAGE) than the config endpoint
            // (CMD_API_SHOW_USER_CONFIG). The config endpoint only carries
            // LIMITS (bandwidth / quota); reading `daConfig.bandwidth_usage`
            // / `daConfig.quota_usage` from it returns undefined for every
            // user — which is why `/admin/hosting` had been silently
            // displaying "0 B / 1 GB" for every account since the page
            // existed. Fix landed 2026-06-22.
            let daUsage: DaUserConfig = {};

            try {
                // Perf: on the fast-paint path (firstPageParam > 0), skip
                // the per-user usage call. Config alone gives us domain,
                // package, status, limits, PHP version — enough for the
                // first meaningful render. Actual bandwidth/disk USED
                // numbers require the dedicated usage endpoint; those
                // show as '0' on Pass 1 and get filled in when Pass 2
                // (the un-firstPage-capped full fetch) runs. Halves the
                // DA fan-out on Pass 1 (2 calls per user → 1) which is
                // where the visible spinner cost lives. Full fetch
                // (Pass 2, firstPageParam === 0) still calls both.
                const skipUsageForFastPaint = firstPageParam > 0;
                [daConfig, daUsage] = await Promise.all([
                    DirectAdminService.getUserConfig(daUsername),
                    skipUsageForFastPaint
                      ? Promise.resolve({} as DaUserConfig)
                      : DirectAdminService.getUserUsage(daUsername).catch((e: unknown) => {
                          // Usage-fetch failure shouldn't block the row — log
                          // and continue with zeros. Config is the more
                          // important one; usage is just a display nicety.
                          serverLogger.warn(
                              `[ADMIN-HOSTING-STATS] Usage fetch failed for ${daUsername}:`,
                              e instanceof Error ? e.message : String(e)
                          );
                          return {} as DaUserConfig;
                      }),
                ]);

                if (!localUser && daConfig.email) {
                    // Try simple email match from our pre-fetched list? No, simpler to just skip or rely on what we have.
                    // Doing a DB call here is okay as it's not external.
                    const userByEmail = await getUserBriefByEmail(daConfig.email);
                    if (userByEmail) {
                        localUser = userByEmail as unknown as LocalUser;
                        linkedByEmail = true;
                    }
                }
            } catch (e: unknown) {
                // If specific user fetch fails.
                const errMessage = e instanceof Error ? e.message : String(e);
                return {
                    id: daUsername,
                    daUsername,
                    status: 'error',
                    error: errMessage,
                    domain: 'Error fetching',
                    user: { name: 'Unknown', email: 'N/A' },
                    usage: { bandwidth: '0', disk: '0', bandwidthLimit: '0', diskLimit: '0' },
                    package: 'Unknown',
                    phpVersion: 'Unknown'
                };
            }

            const bandwidth = daConfig.bandwidth || '0';
            const quota = daConfig.quota || '0';

            // Usage fields prefer the dedicated usage endpoint's values; fall
            // back to the (usually-empty) config-endpoint fields for backwards
            // compat with any DA build that happens to include them there.
            const usage = {
              bandwidth: daUsage.bandwidth || daConfig.bandwidth_usage || '0',
              disk: daUsage.quota || daUsage.disk || daConfig.quota_usage || '0',
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

            // Strategy: Pick the best matching local record for THIS domain.
            // Case-insensitive match — DA occasionally round-trips domain
            // casing that differs from what the Hosting doc stored (e.g.
            // "HiHello.com" from DA vs "hihello.com" in Mongo). Before the
            // toLowerCase pair, the strict === would return [] on any case
            // divergence → hostingRecord undefined → isTrial defaulted to
            // false → the TRIAL badge silently disappeared from
            // /admin/hosting even though the Mongo row correctly had
            // isTrial=true. Fix landed 2026-07-03. Optional-chained
            // toLowerCase so a null domainName doesn't crash (defensive).
            const allHosting = hostingRecords as unknown as HostingRecord[];
            const daDomainLc = daConfig.domain?.toLowerCase() ?? "";
            const domainRecords = allHosting.filter(
              (h) => h.domainName?.toLowerCase() === daDomainLc
            );

            // 1. Exact Username match
            // 2. Or 'active' status
            // 3. Or just the latest (as list is sorted by createdAt: -1)
            let hostingRecord = domainRecords.find((h) => h.directAdminUsername === daUsername);
            if (!hostingRecord) {
                hostingRecord = domainRecords.find((h) => h.status === 'active');
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
              dbId: hostingRecord ? hostingRecord._id.toString() : (localUser ? localUser._id.toString() : null),
              userId: localUser ? localUser._id.toString() : null,
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
              linkedByEmail: linkedByEmail,
              // Tokens-flow visibility (Phase 2I — admin UI surfaces).
              // null when the Hosting doesn't have a recurring-payment
              // mandate set up; populated when CIT auth completed.
              subscriptionId: hostingRecord?.subscriptionId ?? null,
              razorpayCustomerId: hostingRecord?.razorpayCustomerId ?? null,
              razorpayTokenId: hostingRecord?.razorpayTokenId ?? null,
              isTrial: hostingRecord?.isTrial ?? false,
              billingType: hostingRecord?.billingType ?? null,
            };
        }));
    } else {
        // FALLBACK DB MODE: Iterate over Hosting Records + Users
        // This won't be as complete for "unlinked" users existing only on DA, 
        // but it shows what we know about.
        
        // 1. Map from Hosting Collection (primary source of truth for "active" services we know about)
        const dbStats: HostingStatRow[] = (hostingRecords as unknown as HostingRecord[]).map((h) => {
             const localUser = (localUsers as LocalUser[]).find((u) => u._id.toString() === h.userId.toString());
             return {
                 id: h._id.toString(),
                 dbId: h._id.toString(),
                 userId: String(h.userId),
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
                 // Tokens-flow visibility (Phase 2I — admin UI surfaces).
                 subscriptionId: h.subscriptionId ?? null,
                 razorpayCustomerId: h.razorpayCustomerId ?? null,
                 razorpayTokenId: h.razorpayTokenId ?? null,
                 isTrial: h.isTrial ?? false,
                 billingType: h.billingType ?? null,
                 isUnlinked: !localUser, // If we have a hosting record but no user?
                 linkedByEmail: false,
                 // Durable DA-provisioning failure reason (stamped by the
                 // tokens-da provisioner). Surfaces WHY a pending row is stuck.
                 error: h.lastProvisionError || undefined,
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

    // Totals-across-the-whole-dataset counter payload. Two dimensions to
    // reconcile: the VISIBLE ROWS on /admin/hosting come from DA users
    // (via listUsers → per-user config), NOT from Mongo Hosting docs.
    // Most existing paid customers on this DA server predate the Mongo
    // Hosting collection (migrated from an older stack) so their DA
    // accounts exist WITHOUT matching Hosting docs. Initial version of
    // this counter (2026-07-03 first attempt) filtered
    // hostingRecords.length directly — that undercounted paid badly on
    // the karmaastar test dataset (Mongo had 1 trial doc, DA had ~65
    // users, counter showed "1 / 1 trial / 0 paid" instead of the true
    // "65 / 1 trial / 64 paid").
    //
    // Correct algorithm: iterate ALL DA users (already fetched via
    // listUsers as `daUserList` — cheap, no DA fan-out) and decide trial
    // vs paid via set-membership: DA username IS in the set of Mongo
    // Hosting docs with isTrial=true (excluding terminated) → trial;
    // else paid. This matches what the operator will see once Pass 2
    // backfills the full row set + is what makes the counter truthful
    // from Pass 1 onward.
    //
    // Excludes 'terminated' rows from the trial set so a converted /
    // cancelled trial doesn't still count as trial. Expired/suspended
    // rows still count as trial (if isTrial=true) because they're real
    // rows the operator interacts with.
    //
    // DB-fallback mode (DA unreachable) falls back to counting
    // hostingRecords directly since daUserList is empty in that path.
    type CountableHostingRecord = { isTrial?: boolean; status?: string; directAdminUsername?: string };
    const countableRecords = (hostingRecords as unknown as CountableHostingRecord[])
      .filter((h) => h.status !== 'terminated');

    const trialDaUsernameSet = new Set<string>(
      countableRecords
        .filter((h) => h.isTrial === true && !!h.directAdminUsername)
        .map((h) => h.directAdminUsername as string)
    );

    const trialTotalCount = isDaAvailable
      ? daUserList.filter((u) => trialDaUsernameSet.has(u)).length
      : countableRecords.filter((h) => h.isTrial === true).length;
    const paidTotalCount = isDaAvailable
      ? Math.max(0, daUserList.length - trialTotalCount)
      : countableRecords.filter((h) => h.isTrial !== true).length;
    const totalHostingCount = isDaAvailable
      ? daUserList.length
      : countableRecords.length;

    const response = NextResponse.json({
      success: true,
      data: hostingStats,
      source: isDaAvailable ? 'live' : 'db',
      isDaConnected: isDaAvailable,
      daError: daError,
      daMode,
      warning: isDaAvailable ? null : `DirectAdmin unreachable: ${daError}`,
      // Pagination hint — used by the admin hosting page to decide
      // whether a background "fetch the rest" request is needed after
      // the fast first-page render.
      pagination: {
        returned: hostingStats.length,
        total: totalUsers,
        truncated,
      },
      // Totals across the FULL dataset visible to the operator (DA
      // users under LIVE mode, Mongo Hosting docs under DB-fallback).
      // Populated on both Pass 1 and Pass 2 responses so the admin
      // page's badges are correct regardless of which pass the frontend
      // is currently rendering from.
      counts: {
        totalHostings: totalHostingCount,
        trial: trialTotalCount,
        paid: paidTotalCount,
      },
    });
    
    return addSecurityHeaders(response);

  } catch (error: unknown) {
    const errMessage = error instanceof Error ? error.message : String(error);
    serverLogger.error(`Admin Hosting Stats Error:`, errMessage);

    // In strict error case, try to return DB data one last time if we haven't already
    try {
        type FallbackHosting = { _id: { toString(): string }; userId: { toString(): string }; domainName: string; status: string; name?: string; expiryDate?: Date; createdAt?: Date };
        type FallbackUser = { _id: { toString(): string }; firstName: string; lastName: string; email: string };
        const fallbackHosting = (await (await import("@/models/Hosting")).default.find({}).lean()) as unknown as FallbackHosting[];
        const fallbackUsers = (await listAllUserBriefs()) as unknown as FallbackUser[];

        const fallbackStats = fallbackHosting.map((h) => {
            const u = fallbackUsers.find((u) => u._id.toString() === h.userId.toString());
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

