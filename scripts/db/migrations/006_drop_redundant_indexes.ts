/**
 * Migration 006: Drop redundant single-field indexes on Domain and
 * SystemLog (rescan-4 M7, 2026-05-22).
 *
 * Mongo plans prefix-only queries against compound indexes, so a
 * standalone single-field index whose field is a prefix of a compound is
 * pure dead weight — RAM, write amplification, no read benefit.
 *
 * Domain:
 *   - `{ userId: 1, status: 1 }` is a prefix of `{ userId: 1, status: 1, expiresAt: 1 }` — drop the shorter one.
 *   - `{ next_action_at: 1 }` is a prefix of `{ next_action_at: 1, processing_until: 1 }` — drop the shorter one.
 *
 * SystemLog:
 *   - standalone `{ service: 1 }` is a prefix of `{ service: 1, createdAt: -1 }` — drop the shorter one.
 *   - standalone `{ createdAt: -1 }` is not strictly redundant for unfiltered time-ordered scans,
 *     but: SystemLog is a capped collection (insertion-ordered by createdAt anyway), and the only
 *     reader paths filter on level/service first. Drop it.
 */
import type { Connection } from "mongoose";

export async function up(db: Connection) {
  const domains = db.collection("domains");
  await domains.dropIndex("userId_1_status_1").catch(() => {});
  await domains.dropIndex("next_action_at_1").catch(() => {});

  const systemLogs = db.collection("systemlogs");
  await systemLogs.dropIndex("service_1").catch(() => {});
  await systemLogs.dropIndex("createdAt_-1").catch(() => {});
}

export async function down(db: Connection) {
  const domains = db.collection("domains");
  await domains.createIndex({ userId: 1, status: 1 }, { background: true });
  await domains.createIndex({ next_action_at: 1 }, { background: true });

  const systemLogs = db.collection("systemlogs");
  await systemLogs.createIndex({ service: 1 }, { background: true });
  await systemLogs.createIndex({ createdAt: -1 }, { background: true });
}
