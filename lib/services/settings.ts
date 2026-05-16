/**
 * Settings service.
 *
 * Centralised reads / writes for the `Settings` key-value collection. Replaces
 * the older class-style `lib/settings-service.ts` and the scatter of direct
 * `Settings.findOne({ key })` calls inside route handlers.
 *
 * Reads swallow DB errors and return the supplied default — the call sites are
 * mostly feature flags / toggles where a transient DB blip should fall through
 * to the conservative default rather than 500 the request.
 */

import connectDB from "@/lib/mongodb";
import Settings from "@/models/Settings";
import { serverLogger } from "@/lib/server-logger";

export interface SettingsDoc {
  key: string;
  value: unknown;
  description?: string;
  category?: string;
  updatedAt?: Date;
  updatedBy?: string;
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * Read a single setting's `value` field, falling back to `defaultValue` when
 * the row doesn't exist or the lookup throws. The most common shape — use
 * this for feature flags, TTLs, key toggles, etc.
 */
export async function getSettingValue<T = unknown>(
  key: string,
  defaultValue: T | null = null
): Promise<T | null> {
  try {
    await connectDB();
    const doc = await Settings.findOne({ key }).lean<{ value: T }>();
    return doc?.value ?? defaultValue;
  } catch (error) {
    serverLogger.error(`[settings] getSettingValue(${key}) failed`, error);
    return defaultValue;
  }
}

/**
 * Read the full settings document (key + value + metadata). Use when callers
 * need the metadata (description / category / updatedAt). For value-only
 * reads, prefer {@link getSettingValue}.
 */
export async function getSetting(key: string): Promise<SettingsDoc | null> {
  await connectDB();
  return Settings.findOne({ key }).lean<SettingsDoc>();
}

/**
 * Batch-read multiple settings by key. Returns a `{ [key]: value }` map; keys
 * with no matching row are omitted. One round-trip instead of N.
 */
export async function getSettingsMap(
  keys: string[]
): Promise<Record<string, unknown>> {
  if (keys.length === 0) return {};
  await connectDB();
  const docs = await Settings.find({ key: { $in: keys } }).lean<
    Array<{ key: string; value: unknown }>
  >();
  return Object.fromEntries(docs.map((d) => [d.key, d.value]));
}

/**
 * List every settings row, sorted by category then key. Admin-panel read.
 */
export async function listSettings(): Promise<SettingsDoc[]> {
  await connectDB();
  return Settings.find({}).sort({ category: 1, key: 1 }).lean<SettingsDoc[]>();
}

// ─── Writes ───────────────────────────────────────────────────────────────────

interface UpsertOpts {
  description?: string;
  category?: string;
  updatedBy?: string;
}

/**
 * Upsert a setting. Creates the row when missing, otherwise overwrites
 * `value` plus any metadata fields supplied. `updatedAt` always refreshes.
 */
export async function upsertSetting(
  key: string,
  value: unknown,
  opts: UpsertOpts = {}
): Promise<void> {
  await connectDB();
  const update: Record<string, unknown> = {
    key,
    value,
    updatedAt: new Date(),
    updatedBy: opts.updatedBy ?? "system",
  };
  if (opts.description !== undefined) update.description = opts.description;
  if (opts.category !== undefined) update.category = opts.category;
  await Settings.findOneAndUpdate({ key }, update, { upsert: true });
}

/**
 * Delete a setting row. No-op if missing.
 */
export async function deleteSetting(key: string): Promise<void> {
  await connectDB();
  await Settings.deleteOne({ key });
}
