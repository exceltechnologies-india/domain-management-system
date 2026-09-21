/**
 * Migration 008: Drop the unique constraint on Domain.orderId (2026-09-21).
 *
 * `Domain.orderId` holds OUR order id, and one order can contain several
 * domains — it is a one-to-many relation that was declared
 * `unique: true, sparse: true`. `provisionCartItems` fans a single `orderId`
 * across every domain in the cart, so on a two-domain order the second
 * `Domain.create` threw E11000. The catch around it logged and fell through to
 * `return { registrationResult: { status: "success" } }`, so the money was
 * spent, the domain really was registered at ResellerClub, and no Domain row
 * existed — invisible to renewals, expiry reminders and the dashboard.
 *
 * Reproduced against the local database before writing this: two inserts
 * sharing an orderId, second one E11000, one row stored out of two.
 *
 * `resellerClubOrderId` keeps its unique index and should. That one is the
 * registrar's own per-domain order id, so it genuinely is one-per-row, and it
 * is the field that actually protects against a double registration.
 *
 * The index itself is KEPT, just not unique: `findOne({ orderId })` and
 * order-scoped lookups still use it.
 *
 * NOTE FOR PRODUCTION: this drops and recreates an index on a live
 * collection. `background: true` on the recreate keeps it non-blocking. If the
 * collection is large, run it in a quiet window and confirm
 * `db.domains.getIndexes()` afterwards — the recreate is what makes existing
 * lookups keep their index, so a partial run that drops without recreating
 * would leave those queries doing a collection scan.
 */
import type { Connection } from "mongoose";

export async function up(db: Connection) {
  const domains = db.collection("domains");

  await domains.dropIndex("orderId_1").catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    // Already gone, or the collection does not exist yet on a fresh install.
    if (!/index not found|ns not found/i.test(msg)) throw err;
  });

  // Same key, same sparse behaviour, WITHOUT unique.
  await domains.createIndex({ orderId: 1 }, { sparse: true, background: true });
}

export async function down(db: Connection) {
  const domains = db.collection("domains");
  await domains.dropIndex("orderId_1").catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/index not found|ns not found/i.test(msg)) throw err;
  });
  /**
   * Deliberately recreated NON-unique, like migration 007's down().
   *
   * Once this migration has run, multi-domain orders legitimately share an
   * orderId, so restoring `unique: true` would fail outright on real data —
   * and if it somehow succeeded it would reinstate the data-loss bug. A
   * rollback that restores a defect is not a rollback. Re-enforcing
   * uniqueness would need a human to decide what to do with the duplicates.
   */
  await domains.createIndex({ orderId: 1 }, { sparse: true, background: true });
}
