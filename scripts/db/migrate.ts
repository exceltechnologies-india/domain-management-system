#!/usr/bin/env node
/**
 * Database Migration Runner
 *
 * Discovers and runs pending migrations in scripts/db/migrations/.
 * Applied migrations are tracked in the `_migrations` MongoDB collection.
 *
 * Usage:
 *   npx ts-node scripts/db/migrate.ts          — run all pending migrations
 *   npx ts-node scripts/db/migrate.ts --status  — show migration status
 *   npx ts-node scripts/db/migrate.ts --dry-run — list pending without applying
 */

import path from "path";
import fs from "fs";
import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const args = process.argv.slice(2);
const STATUS = args.includes("--status");
const DRY_RUN = args.includes("--dry-run");

// ── Migration record schema ───────────────────────────────────────────────────
const MigrationSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  appliedAt: { type: Date, default: Date.now },
});
const Migration = mongoose.models.Migration || mongoose.model("Migration", MigrationSchema, "_migrations");

// ── Helpers ───────────────────────────────────────────────────────────────────
function log(msg: string) {
  console.log(`[migrate] ${msg}`);
}

async function connect() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set in .env.local");
  await mongoose.connect(uri);
  log("Connected to MongoDB");
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  await connect();

  const migrationsDir = path.join(__dirname, "migrations");
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d{3}_.*\.(ts|js)$/.test(f))
    .sort();

  const applied = new Set(
    (await Migration.find({}).lean()).map((m: any) => m.name)
  );

  const pending = files.filter((f) => !applied.has(f));

  if (STATUS) {
    log(`Total migrations: ${files.length}`);
    files.forEach((f) => {
      const state = applied.has(f) ? "✅ applied" : "⏳ pending";
      log(`  ${state}  ${f}`);
    });
    await mongoose.disconnect();
    return;
  }

  if (pending.length === 0) {
    log("No pending migrations.");
    await mongoose.disconnect();
    return;
  }

  log(`${pending.length} pending migration(s):`);
  pending.forEach((f) => log(`  ⏳ ${f}`));

  if (DRY_RUN) {
    log("Dry-run — nothing applied.");
    await mongoose.disconnect();
    return;
  }

  for (const file of pending) {
    const migrationPath = path.join(migrationsDir, file);
    log(`Running ${file}…`);
    try {
      const mod = await import(migrationPath);
      await mod.up(mongoose.connection);
      await Migration.create({ name: file });
      log(`  ✅ ${file} applied`);
    } catch (err: any) {
      log(`  ❌ ${file} FAILED: ${err.message}`);
      await mongoose.disconnect();
      process.exit(1);
    }
  }

  log("All migrations applied.");
  await mongoose.disconnect();
})();
