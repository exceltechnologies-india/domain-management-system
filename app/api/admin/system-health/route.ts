import { NextResponse, NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { getToken } from "next-auth/jwt";
import { AUTH_SECRET } from "@/lib/auth-secret";
import { authOptions } from "@/lib/auth-config";
import { connectToDatabase } from "@/lib/mongoose";
import PendingDomain from "@/models/PendingDomain";
import { countPendingHostingsByStatus } from "@/lib/services/pending-hostings";
import { countUsers } from "@/lib/services/users";
import { countAllOrders } from "@/lib/services/orders";
import Domain from "@/models/Domain";
import { countOpenTickets } from "@/lib/services/support-tickets";
import { ResellerClubAPI } from "@/lib/resellerclub";
import { DirectAdminService } from "@/lib/directadmin";
import { razorpay } from "@/lib/razorpay";
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

    // ── 6. Server metrics ────────────────────────────────────────────────────
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
