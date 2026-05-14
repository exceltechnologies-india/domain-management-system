/**
 * Migration 004: Add indexes to users, pendinghostings, and supporttickets (audit LOW-4, 2026-05-13).
 *
 * These indexes were added to the Mongoose schemas at the same time; this migration
 * guarantees they exist on databases that predate the schema change, independent of
 * Mongoose's autoIndex behavior.
 */
import type { Connection } from "mongoose";

export async function up(db: Connection) {
  const users = db.collection("users");
  await users.createIndex({ role: 1 }, { background: true });
  await users.createIndex({ activationToken: 1 }, { sparse: true, background: true });
  await users.createIndex({ resetToken: 1 }, { sparse: true, background: true });
  await users.createIndex({ pendingEmailToken: 1 }, { sparse: true, background: true });
  await users.createIndex({ directAdminUsername: 1 }, { sparse: true, background: true });
  await users.createIndex({ resellerClubCustomerId: 1 }, { sparse: true, background: true });

  const pending = db.collection("pendinghostings");
  await pending.createIndex({ status: 1 }, { background: true });
  await pending.createIndex({ userId: 1, status: 1 }, { background: true });
  await pending.createIndex({ status: 1, createdAt: -1 }, { background: true });

  const tickets = db.collection("supporttickets");
  await tickets.createIndex({ status: 1, createdAt: -1 }, { background: true });
}

export async function down(db: Connection) {
  const users = db.collection("users");
  await users.dropIndex("role_1").catch(() => {});
  await users.dropIndex("activationToken_1").catch(() => {});
  await users.dropIndex("resetToken_1").catch(() => {});
  await users.dropIndex("pendingEmailToken_1").catch(() => {});
  await users.dropIndex("directAdminUsername_1").catch(() => {});
  await users.dropIndex("resellerClubCustomerId_1").catch(() => {});

  const pending = db.collection("pendinghostings");
  await pending.dropIndex("status_1").catch(() => {});
  await pending.dropIndex("userId_1_status_1").catch(() => {});
  await pending.dropIndex("status_1_createdAt_-1").catch(() => {});

  const tickets = db.collection("supporttickets");
  await tickets.dropIndex("status_1_createdAt_-1").catch(() => {});
}
