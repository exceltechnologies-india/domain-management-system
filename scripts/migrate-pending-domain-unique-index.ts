/**
 * One-time migration: drop the global-per-domainName partial unique index on
 * PendingDomain and replace it with a (domainName, userId) partial unique
 * index. Required to make rescan-1's L5 fix actually work — the application
 * layer was scoping the bulk-upsert filter to (domainName, userId) but the
 * DB-layer unique index was still global, so a second user failing the same
 * name threw E11000 instead of getting a separate audit row.
 *
 * Safe to re-run: the script `syncIndexes()` against the current schema, which
 * drops indexes that no longer match and creates new ones. Existing data is
 * not touched.
 *
 * Run once after deploying the schema change:
 *   npx ts-node scripts/migrate-pending-domain-unique-index.ts
 */

import connectDB from "../lib/mongodb";
import PendingDomain from "../models/PendingDomain";

process.env.NEXTAUTH_URL = process.env.NEXTAUTH_URL || "http://localhost:3000";

async function migrate() {
  await connectDB();

  // syncIndexes() drops any index on the collection that isn't in the schema
  // and creates any that's missing — exactly what we need to swap the old
  // {domainName:1} unique for the new {domainName:1, userId:1} unique.
  const result = await PendingDomain.syncIndexes();
  // eslint-disable-next-line no-console
  console.log("[migrate-pending-domain-unique-index] syncIndexes() result:", result);

  const indexes = await PendingDomain.collection.indexes();
  // eslint-disable-next-line no-console
  console.log("[migrate-pending-domain-unique-index] PendingDomain indexes after migration:");
  for (const idx of indexes) {
    // eslint-disable-next-line no-console
    console.log("  -", idx.name, idx.key, idx.unique ? "(unique)" : "", idx.partialFilterExpression ? `partial:${JSON.stringify(idx.partialFilterExpression)}` : "");
  }
}

migrate()
  .then(() => {
    // eslint-disable-next-line no-console
    console.log("[migrate-pending-domain-unique-index] done");
    process.exit(0);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[migrate-pending-domain-unique-index] failed:", err);
    process.exit(1);
  });
