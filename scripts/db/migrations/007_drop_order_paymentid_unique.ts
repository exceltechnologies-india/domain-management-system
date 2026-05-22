/**
 * Migration 007: Drop the unique index on Order.paymentId (rescan-4 L10,
 * 2026-05-22).
 *
 * paymentId is a legacy field — `razorpayPaymentId` is the real payment
 * identifier (independently indexed). Zero callers read Order by
 * paymentId. The `required: true, unique: true` constraint forced every
 * renewal-webhook construction to fabricate a unique fallback string
 * just to satisfy the index. Dropping it removes that obligation
 * without affecting any read path.
 */
import type { Connection } from "mongoose";

export async function up(db: Connection) {
  const orders = db.collection("orders");
  await orders.dropIndex("paymentId_1").catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/index not found|ns not found/i.test(msg)) throw err;
  });
}

export async function down(db: Connection) {
  const orders = db.collection("orders");
  // Recreating as unique would fail if any duplicate paymentId values
  // exist post-deletion. Restore as non-unique for safety; manual
  // intervention required to re-enforce uniqueness if needed.
  await orders.createIndex({ paymentId: 1 }, { background: true });
}
