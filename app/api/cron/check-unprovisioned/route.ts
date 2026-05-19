import { NextRequest, NextResponse } from "next/server";
import { secureJsonResponse, secureErrorResponse } from "@/lib/api-response-wrapper";
import { serverLogger } from "@/lib/server-logger";
import { EmailService } from "@/lib/email";
import { AuthService } from "@/lib/auth";
import connectDB from "@/lib/mongodb";
import Order, { type IOrder } from "@/models/Order";
import crypto from "crypto";

export const dynamic = "force-dynamic";

/**
 * Scans for orders paid >30 minutes ago that still have domains in "pending"
 * status (provisioning never completed). Emails admin with the list so they
 * can retry manually from the admin panel.
 *
 * Auth: x-cron-secret header (timing-safe comparison) OR admin session.
 * Recommended schedule: every 30 minutes via external cron trigger.
 */
export async function GET(request: NextRequest) {
  try {
    const cronSecret = process.env.CRON_SECRET;
    const providedSecret = request.headers.get("x-cron-secret") ?? "";
    const isCron =
      cronSecret !== undefined &&
      cronSecret.length > 0 &&
      providedSecret.length === cronSecret.length &&
      crypto.timingSafeEqual(Buffer.from(providedSecret), Buffer.from(cronSecret));

    if (!isCron) {
      const isAdmin = await AuthService.isAdmin(request);
      if (!isAdmin) {
        return secureErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
      }
    }

    await connectDB();

    const cutoff = new Date(Date.now() - 30 * 60 * 1000);

    const stuckOrders = await Order.find({
      status: "completed",
      createdAt: { $lt: cutoff },
      "domains.status": "pending",
    })
      .select("orderId userEmail userName createdAt domains")
      .lean();

    serverLogger.info(`[CheckUnprovisioned] Found ${stuckOrders.length} stuck orders`);

    if (stuckOrders.length > 0) {
      const adminEmail = process.env.ADMIN_EMAIL ?? "sales@anutech.in";

      type StuckOrder = Pick<IOrder, "orderId" | "userEmail" | "userName" | "createdAt" | "domains">;
      const orders = stuckOrders as unknown as StuckOrder[];
      const orderList = orders
        .map((o) => {
          const pendingDomains = (o.domains || [])
            .filter((d) => d.status === "pending")
            .map((d) => d.domainName)
            .join(", ");
          const age = Math.round((Date.now() - new Date(o.createdAt).getTime()) / 60000);
          return `• ${o.orderId} — ${o.userEmail || o.userName} — ${pendingDomains} (${age} min ago)`;
        })
        .join("\n");

      await EmailService.sendAdminNotification(
        adminEmail,
        `${stuckOrders.length} paid order(s) have unprovisioned services`,
        `The following completed orders have domains still in <strong>pending</strong> status after 30+ minutes. Manual retry may be required via the admin panel.`,
        { stuckOrders: orders.map((o) => ({ orderId: o.orderId, userEmail: o.userEmail, createdAt: o.createdAt })) }
      ).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        serverLogger.error(`[CheckUnprovisioned] Failed to send admin alert: ${message}`);
      });

      serverLogger.warn(`[CheckUnprovisioned] Admin alerted for ${stuckOrders.length} stuck orders:\n${orderList}`);
    }

    return secureJsonResponse({ checked: stuckOrders.length });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    serverLogger.error("[CheckUnprovisioned] Error:", message);
    return secureErrorResponse("Internal error", 500, "INTERNAL_ERROR");
  }
}
