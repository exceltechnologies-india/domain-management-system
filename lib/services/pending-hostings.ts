/**
 * PendingHosting service.
 *
 * Companion to lib/services/pending-domains.ts — PendingHosting tracks the
 * half-state between "checkout completed for a hosting plan" and "DirectAdmin
 * user is live". Rows are written when the provisioner trips, and admin tools
 * read / retry / delete them.
 *
 * The bulk-delete and cron-sweep call sites are kept here even though they're
 * one-offs — they share the model import surface with the rest, and
 * centralising them is the whole point of the service layer.
 */
import connectDB from "@/lib/mongodb";
import PendingHosting from "@/models/PendingHosting";
import type { IPendingHosting } from "@/models/PendingHosting";

interface CreatePendingHostingInput {
  userId: unknown;
  domain: string;
  package: string;
  daUsername: string;
  error: string;
  status?: "failed" | "pending";
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * Look up a single pending-hosting by `_id`. Returns the hydrated Mongoose
 * doc (callers in the retry flow mutate + `.save()` the `error` field).
 */
export async function getPendingHostingById(
  id: string
): Promise<IPendingHosting | null> {
  await connectDB();
  return PendingHosting.findById(id);
}

/**
 * Admin pending-hostings index — every row, owning-user populated with the
 * `name`/`email` admin tables expect, newest-first.
 */
export async function listPendingHostingsForAdmin(): Promise<IPendingHosting[]> {
  await connectDB();
  return PendingHosting.find({})
    .populate("userId", "name email")
    .sort({ createdAt: -1 });
}

/**
 * Counts by status — used by the system-health and ops dashboards.
 */
export async function countPendingHostingsByStatus(
  status: "failed" | "pending"
): Promise<number> {
  await connectDB();
  return PendingHosting.countDocuments({ status });
}

/**
 * Cron-sweeper read: stuck rows older than `cutoff`. Lean projection of the
 * fields the alerting flow needs — domain, status, createdAt, error, userId.
 */
export async function listStuckPendingHostings(
  cutoff: Date
): Promise<
  Array<{
    _id: unknown;
    domain: string;
    status: string;
    createdAt: Date;
    error?: string;
    userId: unknown;
  }>
> {
  await connectDB();
  return PendingHosting.find({
    status: { $in: ["pending", "failed"] },
    createdAt: { $lt: cutoff },
  })
    .select("domain status createdAt error userId")
    .lean<
      Array<{
        _id: unknown;
        domain: string;
        status: string;
        createdAt: Date;
        error?: string;
        userId: unknown;
      }>
    >();
}

// ─── Writes ───────────────────────────────────────────────────────────────────

/**
 * Persist a failed/pending hosting provision so the admin retry flow can
 * pick it up. Used by the post-payment provisioner and the admin manual-
 * provision route when DirectAdmin returns an error.
 */
export async function createPendingHosting(
  input: CreatePendingHostingInput
): Promise<IPendingHosting> {
  await connectDB();
  return PendingHosting.create({
    userId: input.userId,
    domain: input.domain,
    package: input.package,
    daUsername: input.daUsername,
    error: input.error,
    status: input.status ?? "failed",
  });
}

/**
 * Delete by `_id`. Used by admin "dismiss" + the retry flow on success.
 * Returns the deleted document, or null if not found.
 */
export async function deletePendingHostingById(
  id: string
): Promise<IPendingHosting | null> {
  await connectDB();
  return PendingHosting.findByIdAndDelete(id);
}

/**
 * Bulk delete by DA username — used when an admin permanently removes a
 * hosting account and wants to clear the matching pending-row at the same
 * time. Matches on either `username` (legacy field) or `daUsername`.
 */
export async function deletePendingHostingsByUsername(
  username: string
): Promise<number> {
  await connectDB();
  const result = await PendingHosting.deleteMany({
    $or: [{ username }, { daUsername: username }],
  });
  return result.deletedCount ?? 0;
}
