/**
 * DomainWatch service.
 *
 * Small collection — the cron checks every row each tick and notifies +
 * removes when a watched domain becomes available. Two distinct flows:
 *
 *  - User CRUD: list, count (for the per-user limit), add via upsert,
 *    remove by domain name.
 *  - Cron worker: batch read with `userId` populated, status updates,
 *    and one-shot removal once the user has been notified.
 */
import connectDB from "@/lib/mongodb";
import DomainWatch from "@/models/DomainWatch";
import type { IDomainWatch } from "@/models/DomainWatch";

// ─── User-side reads + writes ────────────────────────────────────────────────

export interface UserWatchSummary {
  _id: any;
  domainName: string;
  lastCheckedAt?: Date;
  lastStatus?: string;
  notifiedAt?: Date;
  createdAt: Date;
}

/**
 * List a user's watched domains, newest-first. Uses a lean projection
 * sized for the dashboard's "your watch list" card.
 */
export async function listWatchesForUser(
  userId: string
): Promise<UserWatchSummary[]> {
  await connectDB();
  return DomainWatch.find({ userId })
    .select("domainName lastCheckedAt lastStatus notifiedAt createdAt")
    .sort({ createdAt: -1 })
    .lean<UserWatchSummary[]>();
}

/**
 * Count the user's existing watches. The user-add route uses this to
 * enforce the per-user limit (`MAX_WATCHES`) before attempting the
 * upsert — cheaper than letting the upsert succeed and then over-counting.
 */
export async function countWatchesForUser(userId: string): Promise<number> {
  await connectDB();
  return DomainWatch.countDocuments({ userId });
}

/**
 * Atomically upsert `(userId, domainName)`. Returns the new or existing
 * doc. Insert defaults set `lastStatus: "unknown"` so the cron picks it
 * up on the next tick. The unique index on `(userId, domainName)` is the
 * real ownership gate — re-adding the same watch returns the existing
 * row instead of duplicating.
 */
export async function upsertUserWatch(
  userId: string,
  domainName: string
): Promise<IDomainWatch> {
  await connectDB();
  return DomainWatch.findOneAndUpdate(
    { userId, domainName },
    { userId, domainName, lastStatus: "unknown" },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

/**
 * Scoped delete. Returns `true` if a row was removed, `false` if the
 * `(userId, domainName)` pair didn't exist — the route layer maps the
 * latter to a 404.
 */
export async function removeUserWatch(
  userId: string,
  domainName: string
): Promise<boolean> {
  await connectDB();
  const result = await DomainWatch.deleteOne({ userId, domainName });
  return result.deletedCount > 0;
}

// ─── Cron worker ─────────────────────────────────────────────────────────────

/**
 * Worker entry: read up to `batchSize` watches with `userId` populated
 * for the notification step. Lean — the worker only reads + updates by
 * `_id`, it doesn't need the full Mongoose Document.
 */
export async function listWatchesForCron(
  batchSize: number
): Promise<any[]> {
  await connectDB();
  return DomainWatch.find({})
    .populate("userId", "email firstName lastName")
    .limit(batchSize)
    .lean();
}

/**
 * Stamp `lastCheckedAt` + `lastStatus`. Called once per watch each cron
 * tick regardless of whether the user is notified — the timestamp tells
 * us the cron actually ran.
 */
export async function recordWatchCheck(
  watchId: string,
  status: string
): Promise<void> {
  await connectDB();
  await DomainWatch.updateOne(
    { _id: watchId },
    { $set: { lastCheckedAt: new Date(), lastStatus: status } }
  );
}

/**
 * One-shot remove by `_id`. The cron deletes after notifying so the
 * user only gets one email per watch — re-watching the same domain
 * creates a fresh row.
 */
export async function removeWatchById(watchId: string): Promise<void> {
  await connectDB();
  await DomainWatch.deleteOne({ _id: watchId });
}
