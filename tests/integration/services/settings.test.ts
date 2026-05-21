/**
 * Service-layer integration tests for lib/services/settings.ts.
 *
 * Covers the read/write contract used by every feature-flag / toggle in the
 * app. The read paths swallow DB errors and fall back to the supplied
 * default — these tests lock that behaviour in so a future refactor that
 * surfaces errors doesn't silently break feature flags.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { clearAllCollections } from "../setup";
import Settings from "@/models/Settings";
import {
  deleteSetting,
  getSetting,
  getSettingValue,
  getSettingsMap,
  listSettings,
  upsertSetting,
} from "@/lib/services/settings";

beforeAll(async () => {
  expect(mongoose.connection.readyState).toBe(1);
  await Settings.syncIndexes();
});

beforeEach(clearAllCollections);

describe("upsertSetting + getSettingValue", () => {
  it("round-trips a value through the typed getter", async () => {
    await upsertSetting("feature.demo", true);
    const v = await getSettingValue<boolean>("feature.demo");
    expect(v).toBe(true);
  });

  it("returns the supplied default when the key is missing", async () => {
    const v = await getSettingValue<number>("does.not.exist", 42);
    expect(v).toBe(42);
  });

  it("returns null by default when no default is supplied", async () => {
    expect(await getSettingValue("missing")).toBeNull();
  });

  it("overwrites the value on second upsert", async () => {
    await upsertSetting("toggle.x", "on");
    await upsertSetting("toggle.x", "off");
    expect(await getSettingValue<string>("toggle.x")).toBe("off");
  });

  it("preserves metadata (description / category / updatedBy) on upsert", async () => {
    await upsertSetting("with.meta", 7, {
      description: "test setting",
      category: "tests",
      updatedBy: "admin@test",
    });
    const doc = await getSetting("with.meta");
    expect(doc?.description).toBe("test setting");
    expect(doc?.category).toBe("tests");
    expect(doc?.updatedBy).toBe("admin@test");
  });
});

describe("getSettingsMap", () => {
  it("batch-reads multiple keys into a {key: value} object, omitting missing", async () => {
    await upsertSetting("a", 1);
    await upsertSetting("b", "two");
    const map = await getSettingsMap(["a", "b", "c"]);
    expect(map).toEqual({ a: 1, b: "two" });
  });

  it("returns an empty object when called with no keys (no DB round-trip)", async () => {
    expect(await getSettingsMap([])).toEqual({});
  });
});

describe("listSettings", () => {
  it("returns rows sorted by category then key", async () => {
    await upsertSetting("z.a", 1, { category: "a" });
    await upsertSetting("a.b", 2, { category: "b" });
    await upsertSetting("y.a", 3, { category: "a" });
    const all = await listSettings();
    // Sorted: category "a" first (z.a, y.a alphabetical by key) then "b" (a.b).
    expect(all.map((s) => s.key)).toEqual(["y.a", "z.a", "a.b"]);
  });
});

describe("deleteSetting", () => {
  it("removes the row; subsequent reads fall through to default", async () => {
    await upsertSetting("doomed", "value");
    await deleteSetting("doomed");
    expect(await getSettingValue("doomed", "fallback")).toBe("fallback");
  });

  it("is a no-op when the key doesn't exist", async () => {
    await expect(deleteSetting("never.existed")).resolves.toBeUndefined();
  });
});

describe("getSettingValue swallows DB errors", () => {
  it("returns the default when Settings.findOne throws", async () => {
    // Spy on the model to throw on read. Settings.findOne returns a query;
    // we monkey-patch a thrower for one call, then restore.
    const original = Settings.findOne;
    // Cast to any-ish so we can replace it temporarily.
    (Settings as unknown as { findOne: (...args: unknown[]) => unknown }).findOne =
      () => {
        throw new Error("simulated db blip");
      };
    try {
      const v = await getSettingValue<boolean>("any.flag", true);
      expect(v).toBe(true);
    } finally {
      (Settings as unknown as { findOne: typeof original }).findOne = original;
    }
  });
});
