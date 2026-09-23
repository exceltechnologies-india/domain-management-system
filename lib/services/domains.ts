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
import { AUTOMATION_CONFIG } from "@/config/automation";

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

// ─── Writes ───────────────────────────────────────────────────────────────────

/**
 * When the reminder ladder should next look at a domain.
 *
 * Derived from the SAME config the provisioner uses, in one place, because
 * `expiresAt` and `next_action_at` are written as a pair and a copy of this
 * arithmetic that drifts would send reminders on the wrong day. There were two
 * copies of the expression before this (`provisioner-domain.ts` and
 * `provisioner-hosting.ts`); the domain one now calls this.
 */
export function reminderTriggerFor(expiresAt: Date): Date {
  const firstReminderDays = Math.max(...AUTOMATION_CONFIG.REMINDER_DAYS);
  return new Date(expiresAt.getTime() - firstReminderDays * 24 * 60 * 60 * 1000);
}

/**
 * Record that a domain has been renewed.
 *
 * The Domain collection is the CANONICAL source for a customer's domain list:
 * `GET /api/user/domains` fills a Map from orders, then pending domains, then
 * this collection last, so these rows overwrite the other two. Its comment says
 * so — "Priority: Domain collection > PendingDomain collection > Order
 * collection" — and the insertion order implements it.
 *
 * Nothing updated it after a renewal. That is not only a stale date on a
 * screen: `daily-scheduler` selects domains by `next_action_at <= now`, and
 * that field is derived from `expiresAt` when the row is created. So a renewed
 * domain kept its pre-renewal trigger and the cron went on treating it as
 * due — reminding a customer to renew something they had just renewed, and
 * feeding the same rows to renewal dunning.
 *
 * `last_reminder_sent` is cleared for the same reason: it belongs to the old
 * cycle, and leaving it would make the new one start halfway through a ladder
 * that had never run.
 *
 * Returns `false` when no row matched rather than throwing — the caller has
 * already renewed at the registrar by this point, and a throw there would be
 * reported to a customer as a failed renewal.
 */
export async function applyDomainRenewal(input: {
  /**
   * Optional. The customer-facing renewal route knows whose domain it is and
   * passes it as a second narrowing. The engine command does not — it acts on
   * a domain, not on behalf of a user — and does not need to: `domainName`
   * carries a unique index among live rows
   * (`{ unique: true, partialFilterExpression: { deletedAt: null } }`), so the
   * name alone identifies at most one.
   */
  userId?: string;
  domainName: string;
  newExpiresAt: Date;
}): Promise<boolean> {
  await connectDB();
  const res = await Domain.updateOne(
    {
      ...(input.userId ? { userId: input.userId } : {}),
      // Stored lower-cased by the provisioner; matched the same way the user
      // domains route compares them.
      domainName: input.domainName.toLowerCase().trim(),
      deletedAt: null,
    },
    {
      $set: {
        expiresAt: input.newExpiresAt,
        next_action_at: reminderTriggerFor(input.newExpiresAt),
        last_reminder_sent: null,
      },
    }
  );
  return res.matchedCount > 0;
}
