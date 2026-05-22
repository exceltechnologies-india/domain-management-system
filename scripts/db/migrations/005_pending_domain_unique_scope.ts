/**
 * Migration 005: Re-scope the PendingDomain partial unique index from
 * {domainName} to {domainName, userId} (rescan-4 H2, 2026-05-22).
 *
 * Rescan-1's L5 fix scoped the bulk-upsert filter in
 * lib/services/payment/provisioner-verification.ts to (domainName, userId)
 * so two users' failed registrations stay as separate audit rows. The
 * schema's partial unique index was supposed to enforce that at the DB
 * layer too, but its expression used `$ne: true` — an operator MongoDB
 * silently rejects in partialFilterExpression — so the unique never
 * actually existed in prod. This migration installs it correctly.
 *
 * Switches to `isArchived: false` (a supported partial-index operator)
 * since the schema field defaults to false. The old `domainName_1` index
 * is dropped if it exists (it usually doesn't, because the rejected spec
 * meant Mongoose's auto-index never created it).
 */
import type { Connection } from "mongoose";

export async function up(db: Connection) {
  const col = db.collection("pendingdomains");

  // Drop the old global unique if it somehow ended up created. dropIndex
  // throws if missing; tolerate that.
  try {
    await col.dropIndex("domainName_1");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/index not found|ns not found/i.test(msg)) throw err;
  }

  await col.createIndex(
    { domainName: 1, userId: 1 },
    {
      unique: true,
      partialFilterExpression: { isArchived: false },
      background: true,
    }
  );
}

export async function down(db: Connection) {
  const col = db.collection("pendingdomains");
  await col.dropIndex("domainName_1_userId_1").catch(() => {});
  // Don't restore the broken `$ne: true` spec; the down() leaves the
  // collection without a unique constraint, matching the pre-migration
  // prod state.
}
