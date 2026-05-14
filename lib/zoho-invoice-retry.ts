/**
 * Background retry for Zoho invoice creation on orders that previously
 * failed or never completed the bookkeeping step. Fire-and-forget — never
 * blocks the caller, never throws.
 *
 * Throttle: 5 minutes between attempts per order (Redis-backed).
 * The atomic claim on Order.zohoInvoiceId ensures concurrent callers
 * don't double-create.
 */

import connectDB from "@/lib/mongodb";
import Order from "@/models/Order";
import User from "@/models/User";
import { ZohoBooksService } from "@/lib/zohobooks";
import { serverLogger } from "@/lib/server-logger";
import { redisCache } from "@/lib/redis";

const THROTTLE_SECONDS = 5 * 60;

interface OrderDocLite {
  _id: any;
  orderId: string;
  userId: any;
  amount: number;
  razorpayPaymentId?: string;
  paymentId?: string;
  domains: any[];
}

export interface RetryResult {
  ok: boolean;
  orderId: string;
  invoiceId?: string;
  invoiceNumber?: string;
  error?: string;
  skipped?: "throttled" | "already_done" | "no_user";
}

async function retryOne(
  order: OrderDocLite,
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

  // Atomic claim: only retry if still in a recoverable state.
  const claimed = await Order.findOneAndUpdate(
    {
      _id: order._id,
      $or: [
        { zohoInvoiceId: { $exists: false } },
        { zohoInvoiceId: null },
        { zohoInvoiceId: "" },
        { zohoInvoiceId: "creation_failed" },
      ],
    },
    { $set: { zohoInvoiceId: "pending_creation" } },
    { new: true }
  );

  if (!claimed) {
    return { ok: false, orderId: order.orderId, skipped: "already_done" };
  }

  const user = await User.findById(order.userId);
  if (!user) {
    serverLogger.warn(`[ZohoRetry] User not found for order ${order.orderId}`);
    await Order.updateOne(
      { _id: order._id, zohoInvoiceId: "pending_creation" },
      { $set: { zohoInvoiceId: "creation_failed" } }
    );
    return { ok: false, orderId: order.orderId, skipped: "no_user", error: "User not found" };
  }

  const items = (order.domains || []).map((d: any) => ({
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
      try {
        await Order.updateOne(
          { _id: order._id },
          {
            $set: {
              zohoInvoiceId: invoice.invoice_id,
              invoiceNumber: invoice.invoice_number,
            },
          }
        );
      } catch (e: any) {
        // E11000 = duplicate-key on the unique invoiceNumber index. Another
        // Order doc already holds this Zoho invoice number (the existing-Zoho-
        // invoice idempotency search returned an invoice whose number is
        // already attributed to a different local order). Keep the local
        // placeholder invoiceNumber, but still attach zohoInvoiceId so View
        // and Download work.
        if (e?.code === 11000) {
          serverLogger.warn(
            `[ZohoRetry] Duplicate invoiceNumber ${invoice.invoice_number} on order ${order.orderId}; storing zohoInvoiceId only.`
          );
          await Order.updateOne(
            { _id: order._id },
            { $set: { zohoInvoiceId: invoice.invoice_id } }
          );
        } else {
          throw e;
        }
      }
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
    await Order.updateOne(
      { _id: order._id, zohoInvoiceId: "pending_creation" },
      { $set: { zohoInvoiceId: "creation_failed" } }
    );
    return { ok: false, orderId: order.orderId, error: "Zoho returned no invoice_id" };
  } catch (err: any) {
    const message =
      err?.response?.data?.message || err?.message || String(err);
    serverLogger.error(`[ZohoRetry] Failed for order ${order.orderId}: ${message}`);
    await Order.updateOne(
      { _id: order._id, zohoInvoiceId: "pending_creation" },
      { $set: { zohoInvoiceId: "creation_failed" } }
    ).catch(() => {});
    return { ok: false, orderId: order.orderId, error: message };
  }
}

async function findStuckOrders(userId: string): Promise<OrderDocLite[]> {
  await connectDB();
  const rows = await Order.find({
    userId,
    status: { $in: ["completed", "paid"] },
    isDeleted: { $ne: true },
    $or: [
      { zohoInvoiceId: { $exists: false } },
      { zohoInvoiceId: null },
      { zohoInvoiceId: "" },
      { zohoInvoiceId: "creation_failed" },
    ],
  })
    .select("_id orderId userId amount razorpayPaymentId paymentId domains")
    .lean();
  return rows as unknown as OrderDocLite[];
}

/**
 * Kick off background retries for the given user's stuck orders.
 * Returns immediately — work continues in the background.
 */
export function selfHealUserInvoices(userId: string): void {
  void (async () => {
    try {
      const stuckOrders = await findStuckOrders(userId);
      if (stuckOrders.length === 0) return;

      serverLogger.info(
        `[ZohoRetry] Self-heal triggered for user ${userId}: ${stuckOrders.length} stuck order(s)`
      );

      // Retry sequentially so we don't blast Zoho with parallel requests
      // for the same user. Each respects its own throttle.
      for (const order of stuckOrders) {
        await retryOne(order);
      }
    } catch (err) {
      serverLogger.error("[ZohoRetry] selfHealUserInvoices failed:", err);
    }
  })();
}

/**
 * Synchronous variant — runs the retry inline and returns per-order results.
 * Bypasses the throttle so user-initiated "Sync now" works immediately.
 */
export async function syncUserInvoicesNow(userId: string): Promise<RetryResult[]> {
  const stuckOrders = await findStuckOrders(userId);
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
