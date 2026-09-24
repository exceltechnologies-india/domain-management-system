/**
 * Migration 009: Retire the Zoho Books invoice fields (2026-09-24).
 *
 * Zoho Books was removed from DMS on 24 Sep 2026 by owner decision — our own
 * GST engine is the only invoice issuer. This migration moves the data the old
 * code kept in `zohoInvoiceId` onto the fields the new code reads:
 *
 *  1. An order Zoho actually invoiced (a real id in `zohoInvoiceId`, and no
 *     `invoiceProvider`) is stamped `invoiceProvider: "zoho"`. This is the
 *     step that matters for money: the primary engine's claim refuses any order
 *     that already has an `invoiceProvider`, so without the stamp these orders
 *     would read as "paid, never invoiced" and a retry could issue a SECOND tax
 *     invoice for a payment Zoho already invoiced.
 *
 *  2. `zohoInvoiceId: "creation_failed"` (the old failure sentinel) becomes
 *     `invoiceFailedAt`, so the order stays visible to the retry paths and to
 *     admin integration-health instead of silently dropping out of both.
 *
 *  3. `zohoInvoiceId: "pending_creation"` (an abandoned in-flight claim) is
 *     also treated as a failure — the process that wrote it is long gone.
 *
 *  4. The `zohoInvoiceId`, `zohoInvoiceId_1` index and per-line
 *     `zohoRecurring*` fields are removed. Nothing reads them any more, and a
 *     Zoho id is useless without Zoho.
 *
 * Measured before writing (production, 24 Sep 2026): 2 orders total, both with
 * a real zohoInvoiceId, neither with an invoiceProvider, no sentinels.
 *
 * Order matters: step 1 runs before step 4 removes the evidence it keys on.
 */
import type { Connection } from "mongoose";

const SENTINELS = ["pending_creation", "creation_failed"];

export async function up(db: Connection) {
  const orders = db.collection("orders");

  // 1. Historical Zoho invoices → already invoiced.
  await orders.updateMany(
    {
      invoiceProvider: { $exists: false },
      zohoInvoiceId: { $exists: true, $nin: [null, "", ...SENTINELS] },
    },
    { $set: { invoiceProvider: "zoho" } }
  );

  // 2 + 3. Old failure / abandoned-claim sentinels → invoiceFailedAt.
  await orders.updateMany(
    {
      invoiceProvider: { $exists: false },
      zohoInvoiceId: { $in: SENTINELS },
    },
    [
      {
        $set: {
          invoiceFailedAt: { $ifNull: ["$updatedAt", "$$NOW"] },
          invoiceFailureReason: "Carried over from the retired Zoho invoice path (migration 009).",
        },
      },
    ]
  );

  // 4. Drop the fields and the index.
  await orders.updateMany(
    { zohoInvoiceId: { $exists: true } },
    { $unset: { zohoInvoiceId: "" } }
  );
  await orders.updateMany(
    { "domains.zohoRecurringProfileStatus": { $exists: true } },
    {
      $unset: {
        "domains.$[].zohoRecurringInvoiceId": "",
        "domains.$[].zohoRecurringProfileStatus": "",
        "domains.$[].zohoRecurringProfileError": "",
      },
    }
  );
  await orders.dropIndex("zohoInvoiceId_1").catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/index not found|ns not found/i.test(msg)) throw err;
  });
}

export async function down() {
  /**
   * Deliberately a no-op. The Zoho ids this migration removes point at a
   * service DMS no longer talks to, so restoring them would restore nothing a
   * user could use. `invoiceProvider: "zoho"` is left in place on purpose — it
   * is what stops a second tax invoice being issued for those payments, and a
   * rollback that re-arms double invoicing is not a rollback.
   */
}
