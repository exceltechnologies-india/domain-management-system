/**
 * Migration 003: Add compound indexes to the orders collection (S3).
 */
import type { Connection } from "mongoose";

export async function up(db: Connection) {
  const orders = db.collection("orders");

  await orders.createIndex({ userId: 1, orderType: 1, createdAt: -1 }, { background: true });
  await orders.createIndex({ userId: 1, status: 1 }, { background: true });
}

export async function down(db: Connection) {
  const orders = db.collection("orders");
  await orders.dropIndex("userId_1_orderType_1_createdAt_-1");
  await orders.dropIndex("userId_1_status_1");
}
