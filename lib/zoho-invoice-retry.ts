/**
 * Background retry for Zoho invoice creation on orders that previously
 * failed or never completed the bookkeeping step. Fire-and-forget — never
 * blocks the caller, never throws.
 *
 * Throttle: 5 minutes between attempts per order (Redis-backed).
 * The Order service's `claimOrderForZohoInvoice` lease ensures concurrent
 * callers don't double-create.
 */

import { getUserById } from "@/lib/services/users";
import User from "@/models/User";
import { ZohoBooksService } from "@/lib/zohobooks";
import { serverLogger } from "@/lib/server-logger";
import { redisCache } from "@/lib/redis";
import {
  claimOrderForZohoInvoice,
  listStuckZohoInvoiceOrders,
  markZohoInvoiceCreationFailed,
  recordZohoInvoiceForOrder,
  type StuckZohoInvoiceOrder,
} from "@/lib/services/orders";

const THROTTLE_SECONDS = 5 * 60;

export interface RetryResult {
  ok: boolean;
  orderId: string;
  invoiceId?: string;
  invoiceNumber?: string;
  error?: string;
  skipped?: "throttled" | "already_done" | "no_user";
}

async function retryOne(
  order: StuckZohoInvoiceOrder,
  options: { skipThrottle?: boolean } = {}
): Promise<RetryResult> {
  const throttleKey = `zoho-retry:${order._id.toString()}`;

  if (!options.skipThrottle) {
    // Skip if attempted recently — prevents tight-loop hammering of Zoho when
    // the user reloads the invoices page repeatedly.
    const recent = await redisCache.get<number>(throttleKey);
    if (recent) {
      return { ok: false, orderId: order.orderId, skipped: "throttled" };
    }
    await redisCache.set(throttleKey, Date.now(), THROTTLE_SECONDS);
  }

  // Atomic claim: accepts unset/null/empty/creation_failed states, so terminal
  // failures still get a fresh attempt when the cron picks them up later.
  const claimed = await claimOrderForZohoInvoice(order._id, {
    allowNull: true,
    allowFailed: true,
  });

  if (!claimed) {
    return { ok: false, orderId: order.orderId, skipped: "already_done" };
  }

  const user = await getUserById(String(order.userId));
  if (!user) {
    serverLogger.warn(`[ZohoRetry] User not found for order ${order.orderId}`);
    await markZohoInvoiceCreationFailed(order._id);
    return {
      ok: false,
      orderId: order.orderId,
      skipped: "no_user",
      error: "User not found",
    };
  }

  type OrderDomain = StuckZohoInvoiceOrder["domains"][number];
  const items = (order.domains || []).map((d: OrderDomain) => ({
    itemType: d.itemType || "domain",
    domainName: d.domainName,
    price: d.price,
    registrationPeriod: d.registrationPeriod || 1,
    periodUnit: d.periodUnit || (d.itemType === "hosting" ? "months" : "years"),
    hostingPlan: d.hostingPlan,
  }));

  try {
    const zoho = ZohoBooksService.getInstance();
    const invoice = await zoho.createInvoice(
      {
        orderId: order.orderId,
        razorpayPaymentId: order.razorpayPaymentId || order.paymentId || "",
        total: order.amount,
      },
      user,
      items,
      "Razorpay",
      true
    );

    if (invoice && invoice.invoice_id) {
      await recordZohoInvoiceForOrder(order._id, {
        invoiceId: invoice.invoice_id,
        invoiceNumber: invoice.invoice_number,
      });
      serverLogger.info(
        `[ZohoRetry] Recovered invoice for order ${order.orderId}: ${invoice.invoice_id}`
      );
      return {
        ok: true,
        orderId: order.orderId,
        invoiceId: invoice.invoice_id,
        invoiceNumber: invoice.invoice_number,
      };
    }

    serverLogger.warn(`[ZohoRetry] Zoho returned no invoice_id for ${order.orderId}`);
    await markZohoInvoiceCreationFailed(order._id);
    return { ok: false, orderId: order.orderId, error: "Zoho returned no invoice_id" };
  } catch (err: unknown) {
    interface AxiosErrLike { response?: { data?: { message?: string } }; message?: string }
    const ae = (err && typeof err === "object" ? err : {}) as AxiosErrLike;
    const message = ae.response?.data?.message || ae.message || String(err);
    serverLogger.error(`[ZohoRetry] Failed for order ${order.orderId}: ${message}`);
    await markZohoInvoiceCreationFailed(order._id).catch(() => {});
    return { ok: false, orderId: order.orderId, error: message };
  }
}

/**
 * Run the throttled retry inline for the given user's stuck orders.
 * Awaitable — callers must await, otherwise the work dies on Cloud Run when
 * CPU is throttled after the response is sent. Each attempt is gated by the
 * 5-min Redis throttle so repeated page loads don't hammer Zoho.
 */
export async function selfHealUserInvoices(userId: string): Promise<RetryResult[]> {
  try {
    const stuckOrders = await listStuckZohoInvoiceOrders(userId);
    if (stuckOrders.length === 0) return [];

    serverLogger.info(
      `[ZohoRetry] Self-heal triggered for user ${userId}: ${stuckOrders.length} stuck order(s)`
    );

    const results: RetryResult[] = [];
    for (const order of stuckOrders) {
      results.push(await retryOne(order));
    }
    return results;
  } catch (err) {
    serverLogger.error("[ZohoRetry] selfHealUserInvoices failed:", err);
    return [];
  }
}

/**
 * Synchronous variant — runs the retry inline and returns per-order results.
 * Bypasses the throttle so user-initiated "Sync now" works immediately.
 */
export async function syncUserInvoicesNow(userId: string): Promise<RetryResult[]> {
  const stuckOrders = await listStuckZohoInvoiceOrders(userId);
  if (stuckOrders.length === 0) return [];

  serverLogger.info(
    `[ZohoRetry] Manual sync requested for user ${userId}: ${stuckOrders.length} stuck order(s)`
  );

  const results: RetryResult[] = [];
  for (const order of stuckOrders) {
    results.push(await retryOne(order, { skipThrottle: true }));
  }
  return results;
}
