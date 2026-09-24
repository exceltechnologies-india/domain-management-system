/**
 * Retry for orders whose invoice attempt FAILED (`invoiceFailedAt` set, no
 * `invoiceProvider`). Runs our own GST engine again through the same
 * chokepoint as every other call site — there is no second engine to fall
 * back to since Zoho Books was removed on 24 Sep 2026.
 *
 * Two entry points, both awaited by their routes (Cloud Run throttles CPU once
 * a response is sent, so fire-and-forget work dies mid-call):
 *  - `selfHealUserInvoices` — on every invoices-page load, throttled to one
 *    attempt per order per 5 minutes (Redis) so reloads cost ~nothing.
 *  - `syncUserInvoicesNow`  — the user's "Sync now", unthrottled.
 *
 * Only ever touches orders where an attempt is KNOWN to have failed, and the
 * engine's claim refuses any order that already has an `invoiceProvider`, so
 * neither path can mint a second invoice for a payment already invoiced.
 */

import { getUserById } from "@/lib/services/users";
import { serverLogger } from "@/lib/server-logger";
import { redisCache } from "@/lib/redis";
import {
  getOrderById,
  listFailedInvoiceOrders,
  markInvoiceCreationFailed,
  type FailedInvoiceOrder,
} from "@/lib/services/orders";
import { createPrimaryInvoice } from "@/lib/services/billing/createPrimaryInvoice";
import { cartItemsFromOrderDomains } from "@/lib/services/payment/order-creator";
import type { RazorpayPaymentDetails } from "@/lib/types";

const THROTTLE_SECONDS = 5 * 60;
/** Same stale-claim window as idempotency.ts and the issue-invoice worker. */
const STALE_CLAIM_MS = 5 * 60 * 1000;

export interface RetryResult {
  ok: boolean;
  orderId: string;
  invoiceNumber?: string;
  error?: string;
  skipped?: "throttled" | "already_done" | "no_user" | "no_order";
}

async function retryOne(
  row: FailedInvoiceOrder,
  options: { skipThrottle?: boolean } = {}
): Promise<RetryResult> {
  const throttleKey = `invoice-retry:${row._id.toString()}`;

  if (!options.skipThrottle) {
    const recent = await redisCache.get<number>(throttleKey);
    if (recent) {
      return { ok: false, orderId: row.orderId, skipped: "throttled" };
    }
    await redisCache.set(throttleKey, Date.now(), THROTTLE_SECONDS);
  }

  // The full document, not the list projection — the engine reads the order
  // itself, and a fresh read also catches an invoice issued since the list ran.
  const order = await getOrderById(String(row._id));
  if (!order) {
    return { ok: false, orderId: row.orderId, skipped: "no_order" };
  }
  if (order.invoiceProvider) {
    return { ok: false, orderId: row.orderId, skipped: "already_done" };
  }

  const user = await getUserById(String(row.userId));
  if (!user) {
    serverLogger.warn(`[InvoiceRetry] User not found for order ${row.orderId}`);
    return { ok: false, orderId: row.orderId, skipped: "no_user", error: "User not found" };
  }

  const paymentId = order.razorpayPaymentId || order.paymentId || "";
  try {
    const result = await createPrimaryInvoice(
      {
        order,
        orderId: order.orderId,
        razorpay_payment_id: paymentId,
        paymentDetails: {
          id: paymentId,
          amount: order.amount,
          currency: order.currency || "INR",
        } as RazorpayPaymentDetails,
        user,
        cartItems: cartItemsFromOrderDomains(order.domains || []),
      },
      { claimOptions: { staleClaimAfterMs: STALE_CLAIM_MS } }
    );

    if (result.provider === "skipped") {
      return { ok: false, orderId: row.orderId, skipped: "already_done" };
    }
    serverLogger.info(
      `[InvoiceRetry] Issued ${result.invoiceNumber} for previously-failed order ${row.orderId}`
    );
    return { ok: true, orderId: row.orderId, invoiceNumber: result.invoiceNumber ?? undefined };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    serverLogger.error(`[InvoiceRetry] Failed again for order ${row.orderId}: ${message}`);
    // Refresh the flag and reason. Swallowing a failure here is right — it
    // must not abort the rest of the sweep — but not silently: this write is
    // what keeps the order visible in integration-health.
    await markInvoiceCreationFailed(order._id, message).catch((markErr: unknown) => {
      serverLogger.error(
        `[InvoiceRetry] ALSO failed to refresh invoiceFailedAt on ${row.orderId}: ` +
          (markErr instanceof Error ? markErr.message : String(markErr))
      );
    });
    return { ok: false, orderId: row.orderId, error: message };
  }
}

/**
 * Throttled retry for one user's failed-invoice orders. Never throws — a
 * page load must not fail because a retry did.
 */
export async function selfHealUserInvoices(userId: string): Promise<RetryResult[]> {
  try {
    const rows = await listFailedInvoiceOrders(userId);
    if (rows.length === 0) return [];
    serverLogger.info(`[InvoiceRetry] Self-heal for user ${userId}: ${rows.length} failed order(s)`);
    const results: RetryResult[] = [];
    for (const row of rows) results.push(await retryOne(row));
    return results;
  } catch (err) {
    serverLogger.error("[InvoiceRetry] selfHealUserInvoices failed:", err);
    return [];
  }
}

/** Unthrottled variant for the user's "Sync now" button. May throw. */
export async function syncUserInvoicesNow(userId: string): Promise<RetryResult[]> {
  const rows = await listFailedInvoiceOrders(userId);
  if (rows.length === 0) return [];
  serverLogger.info(`[InvoiceRetry] Manual sync for user ${userId}: ${rows.length} failed order(s)`);
  const results: RetryResult[] = [];
  for (const row of rows) results.push(await retryOne(row, { skipThrottle: true }));
  return results;
}
