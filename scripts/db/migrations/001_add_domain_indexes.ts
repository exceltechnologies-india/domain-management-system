/**
 * Migration 001: Add compound indexes to the domains collection.
 * These were added to the Mongoose schema on 2026-05-01 (S3); this migration
 * ensures they exist on databases that predate that schema change.
 */
import type { Connection } from "mongoose";

export async function up(db: Connection) {
  const domains = db.collection("domains");

  await domains.createIndex({ userId: 1, status: 1, expiresAt: 1 }, { background: true });
  await domains.createIndex({ userId: 1, expiresAt: 1 }, { background: true });
  await domains.createIndex({ domainName: "text" }, { background: true });
}

export async function down(db: Connection) {
  const domains = db.collection("domains");
  await domains.dropIndex("userId_1_status_1_expiresAt_1");
  await domains.dropIndex("userId_1_expiresAt_1");
  await domains.dropIndex("domainName_text");
}
