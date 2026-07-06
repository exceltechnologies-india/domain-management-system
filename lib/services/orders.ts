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
import crypto from "crypto";
import mongoose from "mongoose";
import type { HydratedDocument } from "mongoose";
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
export async function getOrderByOrderId(
  orderId: string,
  options?: { populate?: { path: string; select?: string } }
): Promise<IOrder | null> {
  await connectDB();
  let query = Order.findOne({ orderId });
  if (options?.populate) query = query.populate(options.populate.path, options.populate.select);
  return query;
}

/**
 * Admin variant of {@link findUserOrder}: accept either `_id` or `orderId`
 * and look up without a userId scope. The admin re-sync flow needs both
 * paths because legacy URLs reference the orderId, but new admin URLs use
 * the Mongo `_id`.
 *
 * Optional `select` projects only the named fields — used by the
 * `clear-invoice-number` admin tool which only needs ids.
 */
export async function getOrderByIdOrOrderId(
  idOrOrderId: string,
  options?: { select?: string }
): Promise<IOrder | null> {
  await connectDB();
  // 24-hex looks like a Mongo `_id`; everything else is treated as the
  // user-facing `orderId` field (e.g. `ord_…`, `rnw_…`). Branch on the
  // detector rather than $or-ing both — keeps the filter intent explicit
  // and means a hypothetical 24-hex string that also happened to equal an
  // existing `orderId` value can't match the wrong row.
  const isObjectId = /^[0-9a-fA-F]{24}$/.test(idOrOrderId);
  let query = Order.findOne(
    isObjectId ? { _id: idOrOrderId } : { orderId: idOrOrderId }
  );
  if (options?.select) query = query.select(options.select);
  return query;
}

/**
 * Cron: completed orders older than `staleAfterMs` that still carry at
 * least one domain item in `pending` status. Used by the
 * /api/cron/check-unprovisioned alert path.
 */
export async function listStuckCompletedOrders(opts: {
  staleAfterMs: number;
  select?: string;
}): Promise<IOrder[]> {
  await connectDB();
  const cutoff = new Date(Date.now() - opts.staleAfterMs);
  let query = Order.find({
    status: "completed",
    createdAt: { $lt: cutoff },
    "domains.status": "pending",
  });
  if (opts.select) query = query.select(opts.select);
  return query.lean<IOrder[]>();
}

/**
 * Admin diagnostic: find every set of orders sharing the same
 * `invoiceNumber`. Two or more orders sharing a number is the root cause
 * of the E11000 duplicate-key errors during the Zoho retry path.
 * Returns up to 100 conflict groups, largest first.
 */
export interface InvoiceNumberConflictGroup {
  _id: string;
  count: number;
  orderIds: mongoose.Types.ObjectId[];
}

export async function findInvoiceNumberConflicts(): Promise<InvoiceNumberConflictGroup[]> {
  await connectDB();
  return Order.aggregate<InvoiceNumberConflictGroup>([
    { $match: { invoiceNumber: { $exists: true, $ne: null } } },
    {
      $group: {
        _id: "$invoiceNumber",
        count: { $sum: 1 },
        orderIds: { $push: "$_id" },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 100 },
  ]);
}

/**
 * Admin diagnostic: hydrate a list of order IDs with the slim projection the
 * invoice-conflicts dashboard renders.
 */
export async function listOrdersByIds(ids: unknown[], select?: string): Promise<IOrder[]> {
  await connectDB();
  if (ids.length === 0) return [];
  let query = Order.find({ _id: { $in: ids } });
  if (select) query = query.select(select);
  return query.lean<IOrder[]>();
}

/**
 * Admin diagnostic: paid/completed orders missing a resolved Zoho invoice
 * (unscoped — the user-scoped variant is {@link listStuckZohoInvoiceOrders}).
 * Used by the admin invoice-conflicts page.
 */
export async function listStuckZohoInvoiceOrdersAdmin(opts?: { limit?: number; select?: string }): Promise<IOrder[]> {
  await connectDB();
  const limit = opts?.limit ?? 100;
  let query = Order.find({
    status: { $in: ["completed", "paid"] },
    isDeleted: { $ne: true },
    $or: [
      { zohoInvoiceId: { $exists: false } },
      { zohoInvoiceId: null },
      { zohoInvoiceId: "" },
      { zohoInvoiceId: "creation_failed" },
      { zohoInvoiceId: "pending_creation" },
    ],
  })
    .sort({ createdAt: -1 })
    .limit(limit);
  if (opts?.select) query = query.select(opts.select);
  return query.lean<IOrder[]>();
}

/**
 * Admin: orders that still have at least one domain item in `pending` or
 * `processing` status. Used by the admin pending-domains view to surface
 * in-flight registrations that haven't been moved to the PendingDomain
 * collection yet. Populates the owner for the table render.
 */
export async function listOrdersWithInFlightDomains(
  opts: { limit?: number } = {}
): Promise<IOrder[]> {
  await connectDB();
  const limit = opts.limit ?? 1000; // hard cap — the admin route merges this in memory
  return Order.find({
    isDeleted: { $ne: true },
    "domains.status": { $in: ["pending", "processing"] },
  })
    .populate("userId", "firstName lastName email phone companyName")
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean<IOrder[]>();
}

/** Total order count — surfaced in the admin system-health dashboard. */
export async function countAllOrders(): Promise<number> {
  await connectDB();
  return Order.countDocuments();
}

/**
 * Admin: orders whose `razorpayPaymentId` is in the supplied list, populated
 * with the owner's name+email. Used by the admin "recent payments" view to
 * enrich Razorpay's payment list with our internal order metadata.
 */
export async function listOrdersByRazorpayPaymentIds(paymentIds: string[]): Promise<IOrder[]> {
  await connectDB();
  if (paymentIds.length === 0) return [];
  return Order.find({ razorpayPaymentId: { $in: paymentIds } })
    .populate("userId", "firstName lastName email", User);
}

/**
 * Admin tool: unset the `invoiceNumber` on a specific order — used to free a
 * collided unique-index value. Returns the matchedCount so the caller can
 * detect "no-op" vs "actually cleared".
 */
export async function clearOrderInvoiceNumber(orderObjectId: unknown): Promise<{ modifiedCount: number }> {
  await connectDB();
  const result = await Order.updateOne(
    { _id: orderObjectId },
    { $unset: { invoiceNumber: "" } }
  );
  return { modifiedCount: result.modifiedCount };
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
/**
 * Webhook-specific lookup: Razorpay's payment-captured payload carries both
 * `notes.receipt` (our internal `orderId`) and `payment.order_id` (the
 * razorpay order id). Either may be the right key depending on how
 * /create-order set the receipt. Match on either; first hit wins. Wraps
 * the previous `Order.findOne({$or:…})` so the webhook stays out of the
 * model layer.
 */
export async function findOrderByRazorpayOrderIdOrInternalId(
  internalOrderId: string | undefined,
  razorpayOrderId: string | undefined
): Promise<HydratedDocument<IOrder> | null> {
  await connectDB();
  const or: Record<string, unknown>[] = [];
  if (internalOrderId) or.push({ orderId: internalOrderId });
  if (razorpayOrderId) or.push({ razorpayOrderId });
  if (or.length === 0) return null;
  return Order.findOne({ $or: or }) as Promise<HydratedDocument<IOrder> | null>;
}

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
  // Branch on ObjectId.isValid and use exactly one filter — mirror of the
  // pattern in getOrderByIdOrOrderId. The previous shape used $or, which
  // was safe under userId scope but kept the same latent footgun (any
  // future caller using this without userId scope would happily match the
  // wrong row).
  const filter: Record<string, unknown> = {
    ...(mongoose.Types.ObjectId.isValid(orderIdOrId)
      ? { _id: orderIdOrId }
      : { orderId: orderIdOrId }),
    userId,
    isDeleted: { $ne: true },
  };
  let query = Order.findOne(filter);
  if (options?.select) query = query.select(options.select);
  return query.lean<IOrder>().exec() as Promise<IOrder | null>;
}

/**
 * Order rows are post-processed for the admin list: when the owning user has
 * been hard-deleted, the populated `userId` is null and we synthesise a stub
 * from the on-order `userName`/`userEmail` snapshot. The result therefore
 * doesn't quite match `IOrder` — the userId is either a populated User-like
 * object or the snapshot stub.
 */
interface AdminOrderRow extends Omit<IOrder, "userId"> {
  userId:
    | {
        _id: unknown;
        firstName: string;
        lastName: string;
        email: string;
        isDeleted?: boolean;
      }
    | null;
}

interface AdminListResult {
  orders: AdminOrderRow[];
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
  /** Include orders still in `pending` state. Default false — checkout
   * intents that haven't been paid clutter the admin orders view. */
  includePending?: boolean;
  /** Restrict to free-trial signups (`orderType: 'hosting_trial'`). Powers
   * the Free Trial tab in /admin/order-management. Trials are always
   * `status: 'pending'` until day-15 conversion, so this implies
   * includePending. */
  trialOnly?: boolean;
}): Promise<AdminListResult> {
  await connectDB();
  const page = Math.max(1, opts.page ?? 1);
  const perPage = Math.max(1, opts.perPage ?? 100);
  const skip = (page - 1) * perPage;
  const baseQuery: Record<string, unknown> = opts.archived
    ? { isDeleted: true }
    : { isDeleted: { $ne: true } };

  // Free Trial tab: filter to trial signups only. This short-circuits the
  // pending-intent filter below (trials are pending-by-design) so it must be
  // handled before that block.
  if (opts.trialOnly) {
    baseQuery.orderType = "hosting_trial";
  }
  // Filter out stale `pending` checkout intents (customer bailed mid-checkout)
  // while KEEPING legitimate pending trial signups + Tokens-CIT auth
  // orders visible. The distinction:
  //   - Stale pending intent: status='pending' + no orderType='hosting_trial'
  //     + no mandateMode='manual'|'tokens'. These are old checkout-abandons
  //     with no signal of what the customer meant to buy.
  //   - Trial signup (manual flow): status='pending' + orderType='hosting_trial'
  //     + mandateMode='manual' + amount=0. Legit; belongs on the admin
  //     dashboard so operators can see who's on trial. Flips to a NEW
  //     Order (real amount) on day 15+ renewal; the trial row stays as
  //     audit trail.
  //   - Tokens CIT auth: status='pending' + orderType='hosting_trial' +
  //     mandateMode='tokens' + amount=2 (₹2 mandate-validation charge).
  //     Legit; belongs on the dashboard.
  //
  // Trial-orders-invisible bug was introduced pre-2026-07-02 when this
  // filter was written under the assumption that pending==bailed-checkout.
  // Manual-flow trial launch (dms-00210, 2026-06-29) broke that assumption
  // silently — operators couldn't see fresh signups in /admin/order-management
  // even though the rows existed. Fix landed 2026-07-02 in this batch.
  if (!opts.includePending && !opts.trialOnly) {
    baseQuery.$or = [
      { status: { $ne: "pending" } },
      {
        status: "pending",
        $or: [
          { orderType: "hosting_trial" },
          { mandateMode: { $in: ["manual", "tokens"] } },
        ],
      },
    ];
  }
  const query = baseQuery;

  const [rawOrders, total] = await Promise.all([
    Order.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(perPage)
      .populate("userId", "firstName lastName email", User),
    Order.countDocuments(query),
  ]);

  const orders: AdminOrderRow[] = rawOrders.map((order) => {
    const o = order.toObject() as unknown as AdminOrderRow;
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
 * Excludes `status: "pending"` — those are checkout intents that haven't
 * been paid yet (created at /create-order time) and don't belong in any
 * user-visible list.
 */
export async function listOrdersForUser(
  userId: unknown,
  opts?: { limit?: number; populateUser?: boolean; select?: string }
): Promise<IOrder[]> {
  await connectDB();
  const limit = opts?.limit ?? 50;
  const populateUser = opts?.populateUser ?? true;
  let query = Order.find({
    userId,
    isDeleted: { $ne: true },
    status: { $ne: "pending" },
  }).sort({ createdAt: -1 });
  if (opts?.select) query = query.select(opts.select);
  if (populateUser) {
    query = query.populate("userId", "firstName lastName email", User);
  }
  // limit=0 (or negative) means "no limit" — used by views that flatten
  // every order's domains and can't tolerate truncation (e.g. DNS mgmt).
  if (limit > 0) query = query.limit(limit);
  return query;
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
  } catch (e: unknown) {
    if ((e as { code?: number })?.code === 11000) {
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

// ─── Pending-order lifecycle ──────────────────────────────────────────────────
//
// To close the race where Razorpay's webhook arrives before our /verify
// endpoint has committed the Order, we persist a row at create-order time
// with `status: "pending"`. Both /verify and the webhook then converge on
// the same row via atomic claim: whichever path wins the `pending →
// processing` transition runs provisioning + Zoho-invoice creation; the
// loser becomes an idempotent no-op.

/**
 * Atomically transition a `pending` order to `processing` and stamp the
 * Razorpay payment metadata. Returns the updated order if we won the claim,
 * or null if the order is already past `pending` (another worker — either
 * /verify or the webhook — beat us to it). The query is guarded on
 * `status: "pending"` so the transition is mutually exclusive even under
 * concurrent calls from /verify and /razorpay/webhook.
 */
export async function claimPendingOrderForProcessing(
  razorpayOrderId: string,
  updates: {
    razorpayPaymentId?: string;
    razorpaySignature?: string;
    paymentVerification?: {
      verifiedAt: Date;
      paymentStatus: string;
      paymentAmount: number;
      paymentCurrency: string;
      razorpayOrderId: string;
    };
  } = {}
): Promise<HydratedDocument<IOrder> | null> {
  await connectDB();
  const set: Record<string, unknown> = { status: "processing" };
  if (updates.razorpayPaymentId) set.razorpayPaymentId = updates.razorpayPaymentId;
  if (updates.razorpaySignature) set.razorpaySignature = updates.razorpaySignature;
  if (updates.paymentVerification) set.paymentVerification = updates.paymentVerification;
  return Order.findOneAndUpdate(
    { razorpayOrderId, status: "pending" },
    { $set: set },
    { new: true }
  ) as Promise<HydratedDocument<IOrder> | null>;
}

/**
 * Typed payload for {@link createOrder} / {@link createOrderInSession}.
 * Mirrors the Order schema's fields; passing fields outside this set is a
 * TS error rather than a silent Mongoose strip. Extra keys can still be
 * added by passing the existing `Record<string, unknown>` fallback if
 * truly needed (legacy back-compat).
 */
export interface CreateOrderInput {
  orderId: string;
  purchaseOrderNumber?: string;
  userId: unknown;
  userName?: string;
  userEmail?: string;
  paymentId: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
  amount: number;
  currency?: string;
  status?: "pending" | "paid" | "processing" | "completed" | "failed" | "refunded";
  domains: unknown[];
  successfulDomains?: string[];
  paymentVerification?: {
    verifiedAt: Date;
    paymentStatus: string;
    paymentAmount: number;
    paymentCurrency: string;
    razorpayOrderId: string;
  };
  invoiceNumber?: string;
  zohoInvoiceId?: string;
  orderType?: "domain" | "hosting" | "bundle" | "renewal" | "hosting_upgrade" | "hosting_trial" | "unknown";
  // Tokens-flow recurring-payment fields. See models/Order.ts and
  // docs/razorpay-tokens-migration.md.
  mandateMode?: "subscription" | "tokens";
  razorpayCustomerId?: string;
  razorpayTokenId?: string;
  upgradeDetails?: {
    hostingId: string;
    fromPlanId: string;
    toPlanId: string;
    remainingDays: number;
  };
}

/**
 * Insert a new Order document. Thin pass-through to the model constructor +
 * save, exposed here so callers don't import the Mongoose model directly.
 * Returns the persisted document so callers can read the generated `_id`.
 *
 * The payload is `CreateOrderInput` plus a loose-record escape hatch so
 * legacy callers still compile while new callers get compile-time
 * checking against the schema shape.
 */
export async function createOrder(
  payload: CreateOrderInput | Record<string, unknown>
): Promise<IOrder> {
  await connectDB();
  return Order.create(payload);
}

/**
 * Session-aware variant of {@link createOrder}: builds the document with `new`
 * and saves inside the supplied Mongoose session so the insert participates
 * in the caller's `withTransaction(...)` block. Returns the saved doc.
 *
 * Use this from routes that need atomic Order+Payment inserts (currently
 * `payments/verify` and `payments/guest/verify`). For non-transactional
 * inserts, prefer {@link createOrder}.
 */
export async function createOrderInSession(
  payload: CreateOrderInput | Record<string, unknown>,
  session: mongoose.ClientSession
): Promise<IOrder> {
  await connectDB();
  const doc = new Order(payload);
  await doc.save({ session });
  return doc;
}

export interface CreateRenewalOrderInput {
  user: {
    _id: mongoose.Types.ObjectId | string;
    firstName?: string;
    lastName?: string;
    email: string;
  };
  payment: {
    id: string;
    amount: number; // paise (Razorpay convention)
    currency: string;
    order_id?: string | null;
  };
  subscriptionId: string;
  domainName: string;
  isMonthly: boolean;
  hostingPlan?: {
    planId: string;
    name: string;
    serverPackage: string;
  };
}

/**
 * Build + save an audit-trail Order row for a hosting-renewal webhook
 * delivery. Replaces the inline `new Order({...}).save()` previously in
 * lib/services/payment/webhook-handlers.ts so the model isn't accessed
 * directly outside this service.
 *
 * The orderId suffix uses `crypto.randomBytes(4).toString("hex")` (8 hex
 * chars, ~4B values) instead of the previous `Math.floor(Math.random() *
 * 1000)` (~1k values). Same collision class as the M3 invoice-number fix
 * — burst renewal webhooks for the same millisecond would otherwise have
 * collided on the orderId unique index.
 */
export async function createRenewalOrder(
  input: CreateRenewalOrderInput
): Promise<HydratedDocument<IOrder>> {
  await connectDB();
  const { user, payment, subscriptionId, domainName, isMonthly, hostingPlan } = input;
  const amountRupees = payment.amount / 100;
  const orderId = `ORD-RNW-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

  const doc = new Order({
    orderId,
    userId: user._id,
    userName: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
    userEmail: user.email,
    paymentId: payment.id,
    razorpayOrderId: payment.order_id || subscriptionId,
    razorpayPaymentId: payment.id,
    razorpaySignature: "webhook_verified",
    amount: amountRupees,
    currency: payment.currency,
    status: "completed",
    orderType: "renewal",
    domains: [
      {
        domainName,
        price: amountRupees,
        currency: payment.currency,
        registrationPeriod: isMonthly ? 1 : 12,
        periodUnit: isMonthly ? "months" : "years",
        status: "registered",
        itemType: "hosting",
        hostingPlan,
      },
    ],
    successfulDomains: [domainName],
    paymentVerification: {
      verifiedAt: new Date(),
      paymentStatus: "captured",
      paymentAmount: amountRupees,
      paymentCurrency: payment.currency,
      razorpayOrderId: payment.order_id || subscriptionId,
    },
  });

  await doc.save();
  return doc;
}

/**
 * Unconditional variant of {@link markZohoInvoiceCreationFailed}: stamps
 * `creation_failed` regardless of the prior value. Used from the payments/verify
 * catch-block where the post-create Zoho call threw and the prior state is
 * indeterminate (we don't want to depend on the `pending_creation` marker
 * having been written first).
 */
export async function forceMarkZohoCreationFailed(
  orderId: string | mongoose.Types.ObjectId
): Promise<void> {
  await connectDB();
  await Order.updateOne(
    { _id: orderId },
    { $set: { zohoInvoiceId: "creation_failed" } }
  );
}

/**
 * Find paid/completed orders that still don't have a Zoho invoice attached
 * (or carry a terminal `creation_failed` marker). The retry cron walks this
 * list per-user; the projection matches what the retry path actually reads.
 */
export interface StuckZohoInvoiceOrder {
  _id: mongoose.Types.ObjectId;
  orderId: string;
  userId: mongoose.Types.ObjectId | string;
  amount: number;
  razorpayPaymentId?: string;
  paymentId?: string;
  domains: IOrder["domains"];
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

// ─── Subdocument helpers ────────────────────────────────────────────────────
//
// The `order.domains[]` array holds both domain and hosting line-items. Route
// handlers repeatedly walk it to find / project entries by `domainName`;
// before these helpers landed, every callsite re-typed the predicate as
// `(d: IOrder['domains'][number]) =>` and inlined the same find expression.

export type OrderDomain = IOrder["domains"][number];

/**
 * Find a single `order.domains[]` subdocument by domain name. Returns
 * `undefined` (not null) so callers can use the standard `if (!domain)`
 * pattern without distinguishing the two falsies.
 *
 * The lookup is exact-match — caller is responsible for any normalisation
 * (most callers pass an already-normalised `domainName` from the request body).
 */
export function findOrderDomain(
  order: Pick<IOrder, "domains">,
  domainName: string
): OrderDomain | undefined {
  return order.domains.find((d) => d.domainName === domainName);
}

/**
 * Project every `order.domains[]` entry through a typed mapper. Thin wrapper
 * around `Array.prototype.map` that pre-types the callback so callsites stop
 * repeating the `(d: IOrder['domains'][number])` annotation.
 */
export function mapOrderDomains<T>(
  order: Pick<IOrder, "domains">,
  mapper: (d: OrderDomain) => T
): T[] {
  return order.domains.map(mapper);
}

/**
 * Filter `order.domains[]` to entries whose `domainName` is in the supplied
 * set. Used by partial-fulfilment pages that want to report on a subset of
 * the cart (e.g. "these three got registered, these two are pending").
 */
export function filterOrderDomainsByName(
  order: Pick<IOrder, "domains">,
  domainNames: Iterable<string>
): OrderDomain[] {
  const wanted = new Set(domainNames);
  return order.domains.filter((d) => wanted.has(d.domainName));
}

// ─── Domain-keyed lookups ───────────────────────────────────────────────────
//
// "Find the order that contains this domain" is one of the most-repeated
// shapes across the codebase. Two variants: user-scoped (privacy-safe; used
// by /api/user/domains/* + /api/domains/*) and admin-scoped (no userId
// filter; used by /api/admin/**). Both filter out soft-deleted rows.

/**
 * Find the order that contains a domain owned by a specific user. Returns
 * null when no such order exists OR when the order exists but the userId
 * doesn't match — both cases map to a 404 in route handlers, which keeps
 * tenant-existence indistinguishable from missing-from-this-user.
 */
export async function findOrderByDomainForUser(
  userId: unknown,
  domainName: string
): Promise<IOrder | null> {
  await connectDB();
  return Order.findOne({
    "domains.domainName": domainName,
    userId,
    isDeleted: { $ne: true },
  });
}

/**
 * Admin variant — find ANY order containing the named domain. No userId
 * scope. Filters out soft-deleted rows. Use only from admin-gated routes;
 * for user-side lookups call {@link findOrderByDomainForUser} instead.
 *
 * `populate` is the standard Mongoose populate path spec — passed through
 * verbatim so booking-status / admin views can attach owner info without
 * needing a separate helper per shape.
 */
export async function findOrderByDomain(
  domainName: string,
  options?: { populate?: { path: string; select?: string } }
): Promise<IOrder | null> {
  await connectDB();
  let query = Order.findOne({
    "domains.domainName": domainName,
    isDeleted: { $ne: true },
  });
  if (options?.populate) query = query.populate(options.populate.path, options.populate.select);
  return query;
}

/**
 * List ALL orders carrying the named domain (no userId scope). Used by the
 * domain-verification sync to update every Order row that references a
 * domain whose status just changed in the registrar. Includes
 * soft-deleted rows because they still need their per-domain status
 * tracked for refund / audit views.
 */
export async function findOrdersByDomainName(
  domainName: string
): Promise<HydratedDocument<IOrder>[]> {
  await connectDB();
  return Order.find({ "domains.domainName": domainName }) as Promise<
    HydratedDocument<IOrder>[]
  >;
}

/**
 * Find an order by Zoho invoice id (the `zohoInvoiceId` field that
 * `payments/verify` writes after a successful Zoho create). User-scoped so
 * the route layer doesn't have to repeat the ownership filter for IDOR
 * defence.
 */
export async function findOrderByZohoInvoiceForUser(
  userId: unknown,
  zohoInvoiceId: string,
  options?: { select?: string }
): Promise<IOrder | null> {
  await connectDB();
  let query = Order.findOne({
    userId,
    zohoInvoiceId,
    isDeleted: { $ne: true },
  });
  if (options?.select) query = query.select(options.select);
  return query;
}

/**
 * Find an order by Razorpay payment id. Used by the renewal flow when only
 * the payment id is known (no order id). Note: distinct from
 * `getOrderByRazorpayPaymentId` which uses the upstream field name —
 * see that helper's doc for the historical reason.
 */
export async function findOrderByRazorpayPaymentField(
  razorpayPaymentId: string
): Promise<IOrder | null> {
  await connectDB();
  return Order.findOne({ razorpayPaymentId });
}

/**
 * Admin: list every order (including soft-deleted) populated with the user
 * fields the admin domain-flatten view needs. Returns lean objects — callers
 * iterate and don't need Mongoose document methods.
 *
 * Use only from admin-gated routes. The shape mirrors what
 * `app/api/admin/domains/route.ts` consumed when it called Order.find({})
 * directly; new admin consumers should reuse this helper instead.
 */
export async function listAllOrdersForAdminDomains(): Promise<IOrder[]> {
  await connectDB();
  return Order.find({ status: { $ne: "pending" } })
    .populate("userId", "firstName lastName email phone companyName")
    .sort({ createdAt: -1 })
    .lean<IOrder[]>();
}

/**
 * Eligibility check: has this user ever placed a trial-hosting order?
 * Returns true if any order with `orderType: "hosting_trial"` exists for
 * `userId`. Used by the one-trial-per-user gate in /api/payments/create-order
 * and /api/user/hosting/trial-eligibility.
 */
export async function userHasPriorTrialOrder(userId: unknown): Promise<boolean> {
  await connectDB();
  const exists = await Order.exists({ userId, orderType: "hosting_trial" });
  return !!exists;
}

/**
 * Eligibility check: has this user (by id OR by email — covers the migration
 * window where an order may have been written before user-account creation)
 * ever placed a hosting order in a non-failed state? Used by the trial-flow
 * pre-flight and the hosting-eligibility endpoint.
 */
export async function findPriorHostingOrderForUser(
  userId: unknown,
  email: string
): Promise<IOrder | null> {
  await connectDB();
  return Order.findOne({
    $or: [{ userEmail: email }, { userId }],
    "domains.itemType": "hosting",
    status: { $in: ["paid", "completed", "processing"] },
  });
}

/**
 * Recent completed orders for a user, used by the dashboard "domains in
 * process" view. `withinDays` defaults to 14 — matches the prior inline
 * default. Sorted oldest first so newer entries can overwrite stale ones
 * when callers de-dupe by name.
 */
export async function listRecentCompletedOrdersForUser(
  userId: unknown,
  opts: { withinDays?: number } = {}
): Promise<IOrder[]> {
  await connectDB();
  const days = opts.withinDays ?? 14;
  return Order.find({
    userId,
    status: "completed",
    createdAt: { $gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) },
  }).sort({ createdAt: 1 });
}

/**
 * User invoice listing: orders that have an `invoiceNumber` set. Returns a
 * lean projection — only the fields the invoices UI renders. Excludes
 * `status: "pending"` for the same reason as {@link listOrdersForUser}.
 */
export async function listUserInvoiceOrders(userId: unknown): Promise<IOrder[]> {
  await connectDB();
  return Order.find({
    userId,
    invoiceNumber: { $exists: true, $ne: null },
    isDeleted: { $ne: true },
    status: { $ne: "pending" },
  })
    .sort({ createdAt: -1 })
    .select("invoiceNumber zohoInvoiceId amount currency status createdAt")
    .lean<IOrder[]>();
}
