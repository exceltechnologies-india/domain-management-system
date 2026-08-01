/**
 * PendingDomain service.
 *
 * PendingDomain holds the half-state between "user paid" and "domain is fully
 * registered at the registrar". Two repeating access shapes warrant service
 * helpers:
 *
 *  1. User-dashboard / -domains views — list rows owned by the caller, with
 *     archived rows hidden by default ({@link listActivePendingDomainsForUser}).
 *  2. Admin item routes — look up a single row by `_id`, defensively trying
 *     both raw-string and ObjectId equality (the legacy collection contains
 *     a few docs whose `_id` is stored as a string). Optionally populating
 *     the owning User with the projection admin pages display
 *     ({@link getPendingDomainById}).
 *
 * Bulk admin actions (deleteOne / findOneAndUpdate / cross-cutting reports)
 * are left as direct model calls — they don't repeat enough to deserve
 * service helpers, and the route layer is where their business logic lives.
 */
import mongoose from "mongoose";
import connectDB from "@/lib/mongodb";
import PendingDomain from "@/models/PendingDomain";
import type { IPendingDomain } from "@/models/PendingDomain";

// Projection used by admin-item routes when populating the owning user.
// Keep in sync with the admin pending-domains list/detail UI's expectations.
const ADMIN_USER_PROJECTION = "firstName lastName email phone companyName";

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * Look up a pending-domain by `_id`. Accepts both raw-string `_id` values
 * (legacy rows) and `ObjectId`s by trying both forms in a single `$or`.
 *
 * `opts.populateUser` swaps in the admin-detail user projection — only set
 * this from admin routes; user routes shouldn't be looking up rows by
 * arbitrary `_id` anyway (use {@link listActivePendingDomainsForUser}).
 */
export async function getPendingDomainById(
  id: string,
  opts?: { populateUser?: boolean }
): Promise<IPendingDomain | null> {
  await connectDB();
  // Persisted pending-domains always have an ObjectId `_id` (the schema was
  // tightened from Mixed → ObjectId, 2026-08-01). Ids that aren't valid
  // ObjectIds — e.g. the synthetic `order_<id>_<domain>` rows the admin list
  // derives from Orders (source: 'order') — never map to a stored doc, so
  // return null rather than let Mongoose CastError on the query.
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  let q = PendingDomain.findById(id);
  if (opts?.populateUser) q = q.populate("userId", ADMIN_USER_PROJECTION);
  return q;
}

/**
 * Look up a pending-domain by its `domainName`. Used by admin tools to check
 * whether a domain is already mid-flight before kicking off a new attempt.
 */
export async function getPendingDomainByName(
  domainName: string
): Promise<IPendingDomain | null> {
  await connectDB();
  return PendingDomain.findOne({ domainName });
}

/**
 * Active rows for a user — the default dashboard view. Filters out archived
 * rows (admins manually archive resolved/abandoned attempts so they stop
 * appearing in user UI). Sorted newest-first to match the user-domains
 * page's expected ordering.
 */
export async function listActivePendingDomainsForUser(
  userId: string
): Promise<IPendingDomain[]> {
  await connectDB();
  return PendingDomain.find({
    userId,
    isArchived: { $ne: true },
  }).sort({ createdAt: -1 });
}

/**
 * Lean projection of every pending-domain's `domainName`. Used by the admin
 * domain index to know which domains are currently mid-flight versus fully
 * registered, without hauling every full document.
 */
export async function listAllPendingDomainNames(): Promise<{ domainName: string }[]> {
  await connectDB();
  return PendingDomain.find({}, { domainName: 1 }).lean<{ domainName: string }[]>();
}
