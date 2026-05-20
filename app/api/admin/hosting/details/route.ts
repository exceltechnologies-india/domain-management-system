import { NextRequest, NextResponse } from "next/server";
import { AuthService } from "@/lib/auth";
import { DirectAdminService } from "@/lib/directadmin";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import connectDB from "@/lib/mongodb";

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/hosting/details
 * Fetches comprehensive hosting details for a specific user.
 * Restricted to Admins only.
 */
export async function GET(request: NextRequest) {
  try {
    // 1. Authenticate and check Admin role
    const isAdmin = await AuthService.isAdmin(request);
    if (!isAdmin) {
      return secureErrorResponse("Unauthorized. Admin access required.", 403, "FORBIDDEN");
    }

    const { searchParams } = new URL(request.url);
    const username = searchParams.get("username");

    if (!username) {
      return secureErrorResponse("Username is required", 400, "BAD_REQUEST");
    }

    await connectDB();

    // 2. Fetch both Config, Usage and ServerInfo
    const [daConfig, daUsage, serverInfo] = await Promise.all([
      DirectAdminService.getUserConfig(username),
      DirectAdminService.getUserUsage(username),
      DirectAdminService.getServerInfo()
    ]);

    // Format stats consistent with the user stats logic but exposed to admin
    const bandwidthLimit = daConfig.bandwidth || '0';
    const quotaLimit = daConfig.quota || '0';
    // Use ResellerClub nameservers instead of DA defaults
    // Use ResellerClub nameservers instead of DA defaults (fallback)
    let nameservers = DirectAdminService.NAMESERVERS;
    try {
        const dnsRecords = await DirectAdminService.getDNSRecords(username, daConfig.domain ?? '');
        const actualNs = dnsRecords
            .filter((r) => r.type === 'NS')
            .map((r) => (r.value ?? '').replace(/\.$/, '')); // Remove trailing dot if present
        
        if (actualNs.length > 0) {
            nameservers = actualNs;
        }
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        serverLogger.warn(`Failed to fetch live nameservers for ${username}: ${message}`);
    }
    // Help resolve limit strings (convert 'unlimited' or '0' to readable values)
    const resolveLimit = (val: string | undefined, fallback: string = '0') => {
        if (!val) return fallback;
        if (val.toLowerCase() === 'unlimited') return 'Unlimited';
        return val;
    };

    // PHP Version Resolution
    let activePhpVersion = 'Default';
    if (daConfig.php_version && daConfig.php_version !== 'Default') {
        activePhpVersion = daConfig.php_version;
    } else if (daConfig.php1_select) {
        activePhpVersion = daConfig.php1_select;
    } else if (daConfig.php === 'ON' && serverInfo.php) {
        activePhpVersion = serverInfo.php;
    }

    const detailedStats = {
      domain: daConfig.domain,
      username: username,
      status: daConfig.suspended === 'yes' ? 'suspended' : 'active',
      ip: daConfig.ip,
      nameservers: nameservers,
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
            // DirectAdmin API usage excludes the default system FTP account, so we add 1 to match the Panel UI.
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
        spam: daConfig.spam === 'ON',
        ssh: daConfig.ssh === 'ON',
        cron: daConfig.cron === 'ON',
        dnscontrol: daConfig.dnscontrol === 'ON'
      },
      package: daConfig.package,
      php: activePhpVersion,
      created: daConfig.date_created,
      type: daConfig.usertype
    };

    return secureJsonResponse({ 
      success: true, 
      data: detailedStats
    });

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    serverLogger.error(`Admin Hosting Details Error:`, message);
    return secureErrorResponse(
      "Failed to fetch hosting details",
      500,
      "DETAILS_FETCH_FAILED"
    );
  }
}
