/**
 * Migration 002: Backfill deletedAt and lastRenewalReminder fields on existing domains.
 * Fields were added to the schema on 2026-05-01 (S16); this sets explicit nulls
 * so all documents have the field present for index compatibility.
 */
import type { Connection } from "mongoose";

export async function up(db: Connection) {
  const domains = db.collection("domains");

  await domains.updateMany(
    { deletedAt: { $exists: false } },
    { $set: { deletedAt: null } }
  );
  await domains.updateMany(
    { lastRenewalReminder: { $exists: false } },
    { $set: { lastRenewalReminder: null } }
  );
}

export async function down(db: Connection) {
  const domains = db.collection("domains");
  await domains.updateMany({}, { $unset: { deletedAt: "", lastRenewalReminder: "" } });
}
