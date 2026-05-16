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
  return Domain.find({ userId }).sort({ createdAt: -1 });
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
