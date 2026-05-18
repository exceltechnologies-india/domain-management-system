/**
 * Order service.
 *
 * Centralises Order-collection access for route handlers. Mirrors the pattern
 * of lib/services/users.ts: domain-meaningful use-case functions rather than
 * thin pass-throughs around individual Mongoose calls.
 *
 * Soft-delete semantics: most user-facing reads must filter out
 * `isDeleted: true`. Admin reads opt in via the `archived` flag. The service
 * applies the right filter so route handlers don't have to remember.
 *
 * Population of `userId` on admin reads is handled here too — and the snapshot
 * fallback (when the User has been hard-deleted but `userName` / `userEmail`
 * are still on the order) is applied inside the service.
 */
import mongoose from "mongoose";
import connectDB from "@/lib/mongodb";
import Order from "@/models/Order";
import type { IOrder } from "@/models/Order";
import User from "@/models/User";

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * Look up an order by its Mongo `_id`. Returns null when not found.
 * Used by admin routes that already know they have a primary-key reference.
 */
export async function getOrderById(id: string): Promise<IOrder | null> {
  await connectDB();
  return Order.findById(id);
}

/**
 * Look up an order by its user-facing `orderId` field (e.g. `ord_…`). Returns
 * null when not found. No privacy gate — caller must enforce ownership.
 */
export async function getOrderByOrderId(orderId: string): Promise<IOrder | null> {
  await connectDB();
  return Order.findOne({ orderId });
}

/**
 * Look up an order by its `razorpayPaymentId`. Used by the payment-verify
 * idempotency guard: if a payment ID is already stored, the verify call is
 * a duplicate and we recover from the existing order instead of charging
 * again. No privacy gate — internal flow only.
 */
export async function getOrderByRazorpayPaymentId(
  razorpayPaymentId: string
): Promise<IOrder | null> {
  await connectDB();
  return Order.findOne({ razorpayPaymentId });
}

/**
 * Look up an order by its `razorpayOrderId`, optionally narrowed by
 * `orderType`. Used by the upgrade-payment handler (which expects a
 * `"hosting_upgrade"` order) and other razorpay-keyed flows.
 */
export async function getOrderByRazorpayOrderId(
  razorpayOrderId: string,
  opts?: { orderType?: string }
): Promise<IOrder | null> {
  await connectDB();
  const filter: Record<string, unknown> = { razorpayOrderId };
  if (opts?.orderType) filter.orderType = opts.orderType;
  return Order.findOne(filter);
}

/**
 * User-scoped fetch by either `_id` or user-facing `orderId`. Filters out
 * soft-deleted orders and confirms ownership in a single query.
 *
 * The OR-on-both lookups lets user-routes accept either identifier without
 * branching at the route layer. Returns null if the order doesn't exist OR
 * isn't owned by the caller — privacy-safe to return as a 404 in either case.
 */
export async function findUserOrder(
  orderIdOrId: string,
  userId: string,
  options?: { select?: string }
): Promise<IOrder | null> {
  await connectDB();
  const or: Record<string, unknown>[] = [{ orderId: orderIdOrId }];
  if (mongoose.Types.ObjectId.isValid(orderIdOrId)) {
    or.push({ _id: orderIdOrId });
  }
  let query = Order.findOne({
    $or: or,
    userId,
    isDeleted: { $ne: true },
  });
  if (options?.select) query = query.select(options.select);
  return query.lean<IOrder>().exec() as Promise<IOrder | null>;
}

interface AdminListResult {
  orders: any[];
  total: number;
  hasMore: boolean;
  page: number;
  perPage: number;
}

/**
 * Admin paginated list. Populates `userId` and, when the user has been
 * deleted, falls back to the `userName` / `userEmail` snapshot fields the
 * order itself carries.
 *
 * `archived: true` returns only soft-deleted orders. Default is non-archived.
 */
export async function listOrdersForAdmin(opts: {
  archived?: boolean;
  page?: number;
  perPage?: number;
}): Promise<AdminListResult> {
  await connectDB();
  const page = Math.max(1, opts.page ?? 1);
  const perPage = Math.max(1, opts.perPage ?? 100);
  const skip = (page - 1) * perPage;
  const query = opts.archived ? { isDeleted: true } : { isDeleted: { $ne: true } };

  const [rawOrders, total] = await Promise.all([
    Order.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(perPage)
      .populate("userId", "firstName lastName email", User),
    Order.countDocuments(query),
  ]);

  const orders = rawOrders.map((order: any) => {
    const o = order.toObject();
    // Hard-deleted user: synthesise userId from on-order snapshot fields.
    if (!o.userId && (o.userName || o.userEmail)) {
      o.userId = {
        firstName: o.userName?.split(" ")[0] || "Unknown",
        lastName: o.userName?.split(" ").slice(1).join(" ") || "",
        email: o.userEmail || "Deleted User",
        _id: null,
        isDeleted: true,
      };
    }
    return o;
  });

  return {
    orders,
    total,
    hasMore: skip + orders.length < total,
    page,
    perPage,
  };
}

/**
 * User-scoped list for the dashboard. Populates `userId` (mostly redundant
 * but matches the historic response shape) and filters soft-deleted orders.
 */
export async function listOrdersForUser(
  userId: string,
  opts?: { limit?: number }
): Promise<IOrder[]> {
  await connectDB();
  const limit = opts?.limit ?? 50;
  return Order.find({
    userId,
    isDeleted: { $ne: true },
  })
    .populate("userId", "firstName lastName email", User)
    .sort({ createdAt: -1 })
    .limit(limit);
}

// ─── Writes (admin) ───────────────────────────────────────────────────────────

/**
 * Soft-archive an order: sets `isDeleted=true` and stamps `deletedAt`. Returns
 * the pre-update document, or null if the id didn't match. Callers (admin
 * routes) use the return value to log which order was archived.
 */
export async function softDeleteOrder(id: string): Promise<IOrder | null> {
  await connectDB();
  return Order.findByIdAndUpdate(id, {
    isDeleted: true,
    deletedAt: new Date(),
  });
}

/**
 * Hard-delete: removes the document entirely. Returns the deleted doc, or
 * null if not found. Should only be reachable from admin tooling with a
 * "permanent=true" opt-in — once gone the order is unrecoverable.
 */
export async function permanentlyDeleteOrder(id: string): Promise<IOrder | null> {
  await connectDB();
  return Order.findByIdAndDelete(id);
}

/**
 * Un-archive a previously soft-deleted order: clears `isDeleted` and unsets
 * `deletedAt`. Returns the pre-update document, or null if not found.
 */
export async function unarchiveOrder(id: string): Promise<IOrder | null> {
  await connectDB();
  return Order.findByIdAndUpdate(id, {
    isDeleted: false,
    $unset: { deletedAt: 1 },
  });
}

// ─── Zoho-invoice idempotency lease ───────────────────────────────────────────
//
// Three callers (post-tasks, idempotency, zoho-invoice-retry) all coordinate
// Zoho-invoice creation through `Order.zohoInvoiceId`. The field acts as a
// mutex:
//   - unset / "" / null  → unclaimed, anyone may create
//   - "pending_creation" → some worker is mid-flight
//   - "<id>"             → invoice exists in Zoho, record the id locally
//   - "creation_failed"  → terminal failure, retried by cron with throttling
//
// Inlining the atomic findOneAndUpdate calls across three files repeatedly
// got the conditions subtly different (e.g. zoho-invoice-retry also accepts
// `null` and a stale "pending_creation"; post-tasks doesn't). Centralising
// the lease guarantees the same invariants everywhere.

/**
 * Attempt to claim an order for Zoho-invoice creation. Returns the order if
 * the claim succeeded (caller is now responsible for finishing or releasing),
 * or null if someone else already holds the claim or already has an invoice.
 *
 * `opts.staleClaimAfterMs` lets retries (zoho-invoice-retry cron) steal an
 * abandoned "pending_creation" claim older than the supplied threshold. The
 * default (no stealing) is correct for the synchronous post-tasks path —
 * a concurrent in-flight claim is the same as a successful one for that flow.
 *
 * `opts.allowNull` accepts `zohoInvoiceId: null` as unclaimed. zoho-invoice-retry
 * has historically tolerated nulls; the synchronous paths do not write nulls
 * but read them defensively.
 */
export async function claimOrderForZohoInvoice(
  orderId: string | mongoose.Types.ObjectId,
  opts?: {
    staleClaimAfterMs?: number;
    allowNull?: boolean;
    allowFailed?: boolean;
  }
): Promise<IOrder | null> {
  await connectDB();
  const unclaimedConditions: Record<string, unknown>[] = [
    { zohoInvoiceId: { $exists: false } },
    { zohoInvoiceId: "" },
  ];
  if (opts?.allowNull) unclaimedConditions.push({ zohoInvoiceId: null });
  if (opts?.allowFailed) {
    // The retry cron picks up orders that previously hit a terminal failure
    // (typically Zoho validation errors that need a config fix). Synchronous
    // paths never want this — a failed claim there is correctly skipped.
    unclaimedConditions.push({ zohoInvoiceId: "creation_failed" });
  }
  if (opts?.staleClaimAfterMs && opts.staleClaimAfterMs > 0) {
    const cutoff = new Date(Date.now() - opts.staleClaimAfterMs);
    unclaimedConditions.push({
      zohoInvoiceId: "pending_creation",
      updatedAt: { $lt: cutoff },
    });
  }
  return Order.findOneAndUpdate(
    { _id: orderId, $or: unclaimedConditions },
    { $set: { zohoInvoiceId: "pending_creation" } },
    { new: true }
  );
}

/**
 * Happy-path completion of a Zoho-invoice claim: stores the real `invoiceId`
 * (plus `invoiceNumber` when provided) so subsequent payment-verify calls
 * skip the creation step.
 *
 * Handles the E11000 unique-index collision on `invoiceNumber`: Zoho's own
 * idempotency layer may return an existing invoice whose number is already
 * attributed to a different local Order. In that case we keep just the
 * `zohoInvoiceId` (View/Download links still work) and skip the conflicting
 * number to preserve the local Order index.
 */
export async function recordZohoInvoiceForOrder(
  orderId: string | mongoose.Types.ObjectId,
  invoice: { invoiceId: string; invoiceNumber?: string }
): Promise<void> {
  await connectDB();
  try {
    await Order.updateOne(
      { _id: orderId },
      {
        $set: {
          zohoInvoiceId: invoice.invoiceId,
          ...(invoice.invoiceNumber
            ? { invoiceNumber: invoice.invoiceNumber }
            : {}),
        },
      }
    );
  } catch (e: any) {
    if (e?.code === 11000) {
      await Order.updateOne(
        { _id: orderId },
        { $set: { zohoInvoiceId: invoice.invoiceId } }
      );
      return;
    }
    throw e;
  }
}

/**
 * Release a "pending_creation" claim back to the unclaimed state. Use when a
 * retryable error occurred (network blip, transient Zoho 5xx). The guard
 * (`zohoInvoiceId: "pending_creation"`) makes the release a no-op if another
 * worker has already won the race.
 */
export async function releaseZohoInvoiceClaim(
  orderId: string | mongoose.Types.ObjectId
): Promise<void> {
  await connectDB();
  await Order.updateOne(
    { _id: orderId, zohoInvoiceId: "pending_creation" },
    { $unset: { zohoInvoiceId: "" } }
  );
}

/**
 * Mark a claim as terminally failed: the cron retrier respects this and
 * stops hammering Zoho for orders that consistently error (e.g. invalid
 * GST number). Differs from {@link releaseZohoInvoiceClaim} in that retries
 * won't pick this up automatically — admin intervention needed.
 */
export async function markZohoInvoiceCreationFailed(
  orderId: string | mongoose.Types.ObjectId
): Promise<void> {
  await connectDB();
  await Order.updateOne(
    { _id: orderId, zohoInvoiceId: "pending_creation" },
    { $set: { zohoInvoiceId: "creation_failed" } }
  );
}

/**
 * Find paid/completed orders that still don't have a Zoho invoice attached
 * (or carry a terminal `creation_failed` marker). The retry cron walks this
 * list per-user; the projection matches what the retry path actually reads.
 */
export interface StuckZohoInvoiceOrder {
  _id: any;
  orderId: string;
  userId: any;
  amount: number;
  razorpayPaymentId?: string;
  paymentId?: string;
  domains: any[];
}

export async function listStuckZohoInvoiceOrders(
  userId: string
): Promise<StuckZohoInvoiceOrder[]> {
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
  return rows as unknown as StuckZohoInvoiceOrder[];
}
