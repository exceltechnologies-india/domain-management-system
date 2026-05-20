import { NextResponse, NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { getToken } from "next-auth/jwt";
import { AUTH_SECRET } from "@/lib/auth-secret";
import { authOptions } from "@/lib/auth-config";
import { connectToDatabase } from "@/lib/mongoose";
import PendingDomain from "@/models/PendingDomain";
import { countPendingHostingsByStatus } from "@/lib/services/pending-hostings";
import { getSettingValue } from "@/lib/services/settings";
import { countUsers } from "@/lib/services/users";
import { countAllOrders } from "@/lib/services/orders";
import Domain from "@/models/Domain";
import { countOpenTickets } from "@/lib/services/support-tickets";
import { ResellerClubAPI } from "@/lib/resellerclub";
import { DirectAdminService } from "@/lib/directadmin";
import { razorpay } from "@/lib/razorpay";
import { ZohoBooksService } from "@/lib/zohobooks";
import { serverLogger } from "@/lib/server-logger";

export const dynamic = "force-dynamic";

function ms() { return Date.now(); }

export async function GET(req: NextRequest) {
  const requestStart = ms();

  try {
    // Try JWT token first (reliable in App Router), fall back to session
    const jwtToken = await getToken({ req, secret: AUTH_SECRET }).catch(() => null);
    const isAdminViaJwt = jwtToken?.role === "admin";

    if (!isAdminViaJwt) {
      const session = await getServerSession(authOptions);
      if (!session || !session.user || session.user.role !== "admin") {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    // ── 1. Database ─────────────────────────────────────────────────────────
    let dbStatus: "operational" | "down" = "operational";
    let dbLatencyMs = 0;
    let dbStats = { users: 0, orders: 0, domains: 0, openTickets: 0, pendingDomains: 0, pendingHosting: 0 };
    const dbStart = ms();
    try {
      await connectToDatabase();
      dbLatencyMs = ms() - dbStart;
      const [users, orders, domains, openTickets, pendingDomains, pendingHosting] = await Promise.all([
        countUsers(),
        countAllOrders(),
        Domain.countDocuments(),
        countOpenTickets(),
        PendingDomain.countDocuments({ status: "pending" }),
        countPendingHostingsByStatus("pending"),
      ]);
      dbStats = { users, orders, domains, openTickets, pendingDomains, pendingHosting };
    } catch (e) {
      serverLogger.error("System Health: Database connection failed", e);
      dbStatus = "down";
      dbLatencyMs = ms() - dbStart;
    }

    // ── 2. Queue & Failed Jobs ───────────────────────────────────────────────
    let domainBacklog = 0, hostingBacklog = 0;
    let domainFailed = 0, hostingFailed = 0;
    try {
      [domainBacklog, hostingBacklog, domainFailed, hostingFailed] = await Promise.all([
        PendingDomain.countDocuments({ status: "pending" }),
        countPendingHostingsByStatus("pending"),
        PendingDomain.countDocuments({ status: "failed" }),
        countPendingHostingsByStatus("failed"),
      ]);
    } catch (e) {
      serverLogger.error("System Health: Failed to fetch queue stats", e);
    }

    // ── 3. ResellerClub ──────────────────────────────────────────────────────
    let resellerClubStatus: "operational" | "down" = "operational";
    let rcBalance: string | null = null;
    let rcBillingMode = "Unknown";
    let rcAccountStatus = "Unknown";
    let rcLatencyMs = 0;
    const rcStart = ms();
    try {
      const rcCheck = await ResellerClubAPI.getResellerDetails();
      rcLatencyMs = ms() - rcStart;
      if (rcCheck.status === "success" && rcCheck.data) {
        rcBillingMode = rcCheck.data.billingmode || "Unknown";
        rcAccountStatus = rcCheck.data.resellerstatus || "Unknown";
        if (rcBillingMode !== "NoBilling" && rcCheck.data.availablebalance) {
          rcBalance = rcCheck.data.availablebalance;
        }
      } else {
        resellerClubStatus = "down";
      }
    } catch (e) {
      serverLogger.error("System Health: ResellerClub ping failed", e);
      resellerClubStatus = "down";
      rcLatencyMs = ms() - rcStart;
    }

    // ── 4. DirectAdmin ───────────────────────────────────────────────────────
    let directAdminStatus: "operational" | "down" = "operational";
    let daPackageCount = 0;
    let daLatencyMs = 0;
    const daStart = ms();
    try {
      const packages = await DirectAdminService.listPackages();
      daLatencyMs = ms() - daStart;
      daPackageCount = packages.length;
    } catch (e) {
      serverLogger.error("System Health: DirectAdmin ping failed", e);
      directAdminStatus = "down";
      daLatencyMs = ms() - daStart;
    }

    // ── 5. Razorpay ──────────────────────────────────────────────────────────
    let razorpayStatus: "operational" | "down" = "operational";
    let razorpayMode: "live" | "test" = process.env.RAZORPAY_KEY_ID?.startsWith("rzp_live") ? "live" : "test";
    let rzpLatencyMs = 0;
    const rzpStart = ms();
    try {
      await razorpay.orders.all({ count: 1 });
      rzpLatencyMs = ms() - rzpStart;
    } catch (e) {
      serverLogger.error("System Health: Razorpay ping failed", e);
      razorpayStatus = "down";
      rzpLatencyMs = ms() - rzpStart;
    }

    // ── 6. Zoho Books ────────────────────────────────────────────────────────
    let zohoBooksStatus: "operational" | "down" = "operational";
    let zohoPlanStatus = "active";
    let zohoPlanName = "";
    let zohoPlanType = "";
    let zohoPlanExpiryDate: string | null = null;
    let zohoDaysUntilExpiry: number | null = null;
    let zohoLatencyMs = 0;

    const zohoConfigured =
      !!process.env.ZOHO_CLIENT_ID &&
      !!process.env.ZOHO_CLIENT_SECRET &&
      !!process.env.ZOHO_REFRESH_TOKEN;

    let dbExpired = false;
    if (zohoConfigured) {
      try {
        await connectToDatabase();
        const expiryValue = await getSettingValue<{ expired?: boolean }>("zoho.subscription_expired");
        dbExpired = expiryValue?.expired === true;
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        serverLogger.warn("[System Health] Could not read Zoho expiry from DB", message);
      }
    }

    if (!zohoConfigured) {
      zohoBooksStatus = "down";
      zohoPlanStatus = "misconfigured";
    } else if (dbExpired) {
      zohoBooksStatus = "down";
      zohoPlanStatus = "expired";
    } else {
      const zohoStart = ms();
      try {
        const zohoService = ZohoBooksService.getInstance();
        const org = await zohoService.getOrganizationDetails();
        zohoLatencyMs = ms() - zohoStart;
        if (!org) throw new Error("Could not fetch organization details from Zoho Books");

        zohoPlanName = (org.plan_name as string | undefined) || "";
        zohoPlanType = (org.plan_type as string | undefined) || "";
        const rawExpiry: string | undefined =
          (org.trial_expiry_date as string | undefined) ||
          (org.plan_expiry_date as string | undefined) ||
          (org.subscription_end_date as string | undefined);

        if (rawExpiry) {
          zohoPlanExpiryDate = rawExpiry;
          zohoDaysUntilExpiry = Math.ceil((new Date(rawExpiry).getTime() - Date.now()) / 86_400_000);
        }

        const isExpired =
          zohoService.isSubscriptionExpired() ||
          org.status === "expired" ||
          org.is_expired === true ||
          (zohoDaysUntilExpiry !== null && zohoDaysUntilExpiry <= 0);

        const isExpiringSoon = !isExpired && zohoDaysUntilExpiry !== null && zohoDaysUntilExpiry <= 7;

        if (isExpired) {
          zohoPlanStatus = "expired";
          zohoBooksStatus = "down";
        } else if (isExpiringSoon) {
          zohoPlanStatus = "trial_expiring";
        } else if (org.plan_type === "trial") {
          zohoPlanStatus = "trial";
        } else {
          zohoPlanStatus = "active";
        }
      } catch (e: unknown) {
        interface ZohoErrLike { code?: string; message?: string }
        const err = (e && typeof e === 'object' ? e : {}) as ZohoErrLike;
        zohoLatencyMs = ms() - zohoStart;
        serverLogger.error("System Health: Zoho Books ping failed", err.message || e);
        if (err.code === "SUBSCRIPTION_EXPIRED" || err.message?.includes("103001")) {
          zohoPlanStatus = "expired";
          zohoBooksStatus = "down";
        } else if (err.code === "AUTH_ERROR" || err.code === "MISSING_REFRESH_TOKEN") {
          zohoBooksStatus = "down";
          zohoPlanStatus = "misconfigured";
        } else {
          zohoBooksStatus = "down";
        }
      }
    }

    // ── 7. Server metrics ────────────────────────────────────────────────────
    const memUsage = process.memoryUsage();
    const serverMetrics = {
      uptimeSeconds: Math.floor(process.uptime()),
      memory: {
        heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
        rssMB: Math.round(memUsage.rss / 1024 / 1024),
      },
      nodeVersion: process.version,
      environment: (process.env.NODE_ENV || "development") as "production" | "development",
      appVersion: "3.3.0",
      totalResponseMs: ms() - requestStart,
    };

    const response = NextResponse.json({
      database: {
        status: dbStatus,
        latencyMs: dbLatencyMs,
        stats: dbStats,
      },
      queueBacklog: {
        domains: domainBacklog,
        hosting: hostingBacklog,
        total: domainBacklog + hostingBacklog,
      },
      failedJobs: {
        domains: domainFailed,
        hosting: hostingFailed,
        total: domainFailed + hostingFailed,
      },
      externalApis: {
        resellerClub: {
          status: resellerClubStatus,
          accountStatus: rcAccountStatus,
          billingMode: rcBillingMode,
          balance: rcBalance,
          latencyMs: rcLatencyMs,
        },
        directAdmin: {
          status: directAdminStatus,
          packageCount: daPackageCount,
          latencyMs: daLatencyMs,
        },
        razorpay: {
          status: razorpayStatus,
          mode: razorpayMode,
          latencyMs: rzpLatencyMs,
        },
        zohoBooks: {
          status: zohoBooksStatus,
          planStatus: zohoPlanStatus,
          planName: zohoPlanName,
          planType: zohoPlanType,
          planExpiryDate: zohoPlanExpiryDate,
          daysUntilExpiry: zohoDaysUntilExpiry,
          latencyMs: zohoLatencyMs,
        },
      },
      server: serverMetrics,
      timestamp: new Date().toISOString(),
    });
    response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
    return response;
  } catch (error: unknown) {
    serverLogger.error("System Health Error", error);
    return NextResponse.json({ error: "Failed to fetch system health" }, { status: 500 });
  }
}
