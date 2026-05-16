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
export async function getHostingById(id: string): Promise<IHosting | null> {
  await connectDB();
  return Hosting.findById(id);
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
 * shape every dashboard caller wants.
 */
export async function listHostingsForUser(
  userId: string,
  opts?: { limit?: number }
): Promise<IHosting[]> {
  await connectDB();
  const limit = opts?.limit ?? 50;
  return Hosting.find({ userId }).sort({ createdAt: -1 }).limit(limit);
}
