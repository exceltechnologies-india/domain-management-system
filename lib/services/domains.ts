/**
 * Domain service.
 *
 * Most Domain-collection access is bespoke business logic (cron lease
 * patterns, provisioner inserts, admin cleanup deletes) that doesn't share
 * shape across callers — those stay direct model calls.
 *
 * What does repeat: listing a user's domains for dashboard/index views, and
 * looking one up by `_id`. Those two helpers go here.
 */
import connectDB from "@/lib/mongodb";
import Domain from "@/models/Domain";
import type { IDomain } from "@/models/Domain";

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * List every domain owned by the given user, newest-first. Used by the user
 * dashboard, user domains index, and DNS-management screen.
 */
export async function listDomainsForUser(
  userId: string
): Promise<IDomain[]> {
  await connectDB();
  // Exclude soft-deleted domains (deletedAt set) — e.g. a domain transferred
  // out to another registrar account and removed from the panel by an admin.
  // `deletedAt: null` matches both null and missing (active) records. The
  // schema already carries a 90-day TTL on deletedAt, so this is reversible
  // within that window. Previously this query omitted the filter, so a
  // soft-deleted domain would still show to the customer until the TTL purged
  // it — this closes that gap.
  return Domain.find({ userId, deletedAt: null }).sort({ createdAt: -1 });
}

/**
 * Look up a domain by `_id`. Returns null when not found. Used by the
 * automation test routes which receive an `_id` and need to fetch the
 * full document.
 */
export async function getDomainById(id: string): Promise<IDomain | null> {
  await connectDB();
  return Domain.findById(id);
}
