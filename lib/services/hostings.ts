/**
 * Hosting service.
 *
 * Same pattern as lib/services/orders.ts and lib/services/users.ts: domain
 * use-case functions, not thin Mongoose pass-throughs.
 *
 * The most repeated access pattern across routes/workers/payment-services is
 * `Hosting.findOne({ userId, domainName })` — looking up a specific user's
 * hosting for a specific domain. {@link findUserHosting} owns that pattern
 * (with `domainName` as an optional narrowing filter).
 */
import connectDB from "@/lib/mongodb";
import Hosting from "@/models/Hosting";
import type { IHosting } from "@/models/Hosting";

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * Look up a hosting record by its Mongo `_id`. Returns null when not found.
 * Used by workers / admin tools that already have a primary-key reference
 * (e.g. via RenewalPayment.serviceId or Hosting.find().select('_id') results).
 */
export async function getHostingById(
  id: string,
  options?: { populateUser?: boolean; lean?: boolean }
): Promise<IHosting | null> {
  await connectDB();
  let query = Hosting.findById(id);
  // Narrow projection — workers that populate only read identity + contact
  // fields. Pulling the full User doc (incl. address/legacy lists) is wasted
  // memory under cron batch sizes.
  if (options?.populateUser) {
    query = query.populate("userId", "email firstName lastName whatsappNumber phone phoneCc");
  }
  if (options?.lean) return query.lean<IHosting>();
  return query;
}

/**
 * Find a hosting record owned by `userId`. Pass `domainName` to narrow to a
 * specific domain (the most common usage — webhook handlers, eligibility
 * checks, renewal lookups). Without `domainName`, returns any single hosting
 * record the user owns (e.g. for "does this user already have hosting?"
 * style checks; see also {@link userHasAnyHosting}).
 */
export async function findUserHosting(
  userId: string,
  opts?: { domainName?: string }
): Promise<IHosting | null> {
  await connectDB();
  const filter: Record<string, unknown> = { userId };
  if (opts?.domainName) filter.domainName = opts.domainName;
  return Hosting.findOne(filter);
}

/**
 * Look up the hosting record created by a specific order — used to find its
 * `directAdminUsername` when reporting the order's items to an external
 * system (e.g. Billing's renewal tracking) that needs it to actually
 * execute a suspend later. `domainName` narrows when an order has more
 * than one hosting line.
 */
export async function findHostingByOrderId(
  orderId: string,
  opts?: { domainName?: string }
): Promise<IHosting | null> {
  await connectDB();
  const filter: Record<string, unknown> = { orderId };
  if (opts?.domainName) filter.domainName = opts.domainName;
  return Hosting.findOne(filter);
}

/**
 * Cheap eligibility shortcut: returns true if the user owns *any* hosting
 * record. Avoids hauling the full document just to check existence.
 */
export async function userHasAnyHosting(userId: string): Promise<boolean> {
  await connectDB();
  const found = await Hosting.findOne({ userId }).select("_id").lean();
  return found != null;
}

/**
 * List hostings for the given user. Default sort is most-recent-first, the
 * shape every dashboard caller wants. `limit: 0` (or negative) returns all —
 * dashboard / sync paths flatten across every hosting so they can't tolerate
 * truncation.
 */
export async function listHostingsForUser(
  userId: unknown,
  opts?: { limit?: number }
): Promise<IHosting[]> {
  await connectDB();
  const limit = opts?.limit ?? 50;
  let query = Hosting.find({ userId }).sort({ createdAt: -1 });
  if (limit > 0) query = query.limit(limit);
  return query;
}

/**
 * Look up a hosting by `_id` scoped to a userId — the safe ownership pattern
 * for /api/user/hosting/[id]/* routes that take an id from the URL.
 */
export async function findUserHostingById(
  hostingId: string,
  userId: unknown
): Promise<IHosting | null> {
  await connectDB();
  return Hosting.findOne({ _id: hostingId, userId });
}

/**
 * Mark every hosting owned by `userId` as just-synced. Used by the dashboard
 * refresh-throttle so a flurry of dashboard loads only queues one background
 * sync job per cooldown window.
 */
export async function touchHostingsLastSyncedForUser(userId: unknown): Promise<void> {
  await connectDB();
  await Hosting.updateMany({ userId }, { $set: { lastSyncedAt: new Date() } });
}

/**
 * Insert a new Hosting document. Thin pass-through to Model.create — the
 * payload type is intentionally loose (mirrors Mongoose's own permissive
 * Model.create), the schema validates at write time.
 */
export async function createHosting(payload: Record<string, unknown>): Promise<IHosting> {
  await connectDB();
  return Hosting.create(payload);
}

/**
 * Daily-scheduler: candidate hostings whose `next_action_at` is due and
 * whose processing lock has expired (or never existed). Lean projection —
 * the scheduler only needs `_id` and `domainName` to dispatch a task.
 */
export async function listDueServiceHostingCandidates(opts: {
  now: Date;
  batchSize: number;
}): Promise<IHosting[]> {
  await connectDB();
  return Hosting.find({
    next_action_at: { $lte: opts.now },
    $or: [
      { processing_until: null },
      { processing_until: { $exists: false } },
      { processing_until: { $lt: opts.now } },
    ],
    status: { $nin: ["failed", "terminated"] },
  })
    .select("_id domainName")
    .limit(opts.batchSize)
    .lean<IHosting[]>();
}

/**
 * Daily-scheduler: atomically acquire the processing lock on a hosting that
 * is still eligible. Returns null when another worker already locked it (so
 * the caller can skip without queueing a duplicate task).
 */
export async function lockHostingForScheduler(opts: {
  hostingId: unknown;
  now: Date;
  lockExpiry: Date;
}): Promise<IHosting | null> {
  await connectDB();
  return Hosting.findOneAndUpdate(
    {
      _id: opts.hostingId,
      $or: [
        { processing_until: null },
        { processing_until: { $exists: false } },
        { processing_until: { $lt: opts.now } },
      ],
    },
    { $set: { processing_until: opts.lockExpiry } },
    { new: false }
  );
}

/**
 * Daily-scheduler: release a lock we acquired but failed to queue a task
 * for. Guarded on the original `lockExpiry` so a concurrent worker can't be
 * blown out — if another path reset processing_until before us, the
 * conditional update is a no-op.
 */
export async function releaseHostingSchedulerLock(opts: {
  hostingId: unknown;
  lockExpiry: Date;
}): Promise<void> {
  await connectDB();
  await Hosting.updateOne(
    { _id: opts.hostingId, processing_until: opts.lockExpiry },
    { $set: { processing_until: null } }
  );
}

/**
 * All hosting rows owned by `userId` that match `domainName`, newest first.
 * Multiple rows for the same (userId, domainName) are possible across
 * repurchase cycles — the stats / sync paths walk all of them to pick the
 * one currently linked to the live DA username.
 */
export async function listUserHostingsByDomain(
  userId: unknown,
  domainName: string
): Promise<IHosting[]> {
  await connectDB();
  return Hosting.find({ userId, domainName }).sort({ createdAt: -1 }).lean<IHosting[]>();
}

/**
 * Stats-sync upsert: write the DA-derived status / plan onto an existing
 * hosting row (matched by `_id` or `(userId, domainName)`), inserting one if
 * none exists. The `$setOnInsert` defaults populate the new row with the
 * fields DA can give us — startDate, expiryDate placeholder, etc.
 */
export async function upsertHostingFromDirectAdminStats(opts: {
  filter: Record<string, unknown>;
  set: Record<string, unknown>;
  setOnInsert: Record<string, unknown>;
}): Promise<void> {
  await connectDB();
  await Hosting.updateOne(
    opts.filter,
    { $set: opts.set, $setOnInsert: opts.setOnInsert },
    { upsert: true }
  );
}

/**
 * Cron: active hostings whose expiry has passed `cutoff`. Returns a slim
 * projection — the auto-suspend queue only needs `_id`, `domainName`, and the
 * DA username for logging.
 */
export async function listExpiredActiveHostings(cutoff: Date): Promise<IHosting[]> {
  await connectDB();
  return Hosting.find({
    status: "active",
    expiryDate: { $lt: cutoff, $ne: null },
  })
    .select("_id domainName directAdminUsername")
    .lean<IHosting[]>();
}

/**
 * Admin diag: every hosting in the DB, projected to the DA-cross-reference
 * fields only. Used by the diag-da endpoint to reconcile DB ↔ DirectAdmin.
 */
export async function listAllHostingsForDirectAdminDiag(): Promise<IHosting[]> {
  await connectDB();
  return Hosting.find({}, "directAdminUsername domainName status").lean<IHosting[]>();
}

/**
 * Admin: every hosting linked to the supplied DirectAdmin username. Multiple
 * rows are possible when a user has bought additional accounts that re-use
 * the same DA username (legacy data) — the delete-action loop needs all of
 * them to cancel subscriptions.
 */
export async function listHostingsByDirectAdminUsername(
  directAdminUsername: string
): Promise<IHosting[]> {
  await connectDB();
  return Hosting.find({ directAdminUsername });
}

/**
 * Admin: delete every hosting matching a `_id` or a DirectAdmin username.
 * Returns the deletedCount so the route can log a sensible message.
 *
 * Caller MUST gate this behind an admin auth check — the helper assumes
 * the route layer enforced the boundary.
 */
export async function deleteHostingsByIdOrUsername(opts: {
  hostingId?: string;
  directAdminUsername?: string;
}): Promise<{ deletedCount: number; matchedHostings: IHosting[] }> {
  await connectDB();
  const query: Record<string, unknown> = opts.hostingId
    ? { _id: opts.hostingId }
    : { directAdminUsername: opts.directAdminUsername };
  const matchedHostings = await Hosting.find(query);
  const result = await Hosting.deleteMany(query);
  return { deletedCount: result.deletedCount ?? 0, matchedHostings };
}
