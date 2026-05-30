/**
 * Tests for `@/lib/settings-service` (rescan-4 slice 7dk).
 * Deprecated class-style shim that delegates to the functional API at
 * `@/lib/services/settings`. Pins the delegation contract so a future
 * rename of the underlying functions surfaces here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getSettingValueMock = vi.hoisted(() => vi.fn());
const upsertSettingMock = vi.hoisted(() => vi.fn());
const listSettingsMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/settings", () => ({
  getSettingValue: getSettingValueMock,
  upsertSetting: upsertSettingMock,
  listSettings: listSettingsMock,
}));

const loggerInfo = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: loggerInfo, warn: vi.fn(), error: vi.fn() },
}));

import { SettingsService } from "@/lib/settings-service";

beforeEach(() => {
  getSettingValueMock.mockReset();
  upsertSettingMock.mockReset();
  listSettingsMock.mockReset();
  loggerInfo.mockReset();
});

describe("SettingsService.getSetting", () => {
  it("delegates to getSettingValue with (key, defaultValue=null)", async () => {
    getSettingValueMock.mockResolvedValueOnce("hello");
    const result = await SettingsService.getSetting<string>("welcome.msg");
    expect(getSettingValueMock).toHaveBeenCalledWith("welcome.msg", null);
    expect(result).toBe("hello");
  });

  it("forwards an explicit defaultValue", async () => {
    getSettingValueMock.mockResolvedValueOnce("from-db");
    await SettingsService.getSetting<string>("k", "fallback");
    expect(getSettingValueMock).toHaveBeenCalledWith("k", "fallback");
  });

  it("returns null when the underlying call resolves null", async () => {
    getSettingValueMock.mockResolvedValueOnce(null);
    expect(await SettingsService.getSetting("missing")).toBeNull();
  });
});

describe("SettingsService.setSetting", () => {
  it("delegates to upsertSetting with the (key, value, {description, category, updatedBy}) shape", async () => {
    upsertSettingMock.mockResolvedValueOnce(undefined);
    await SettingsService.setSetting(
      "k1",
      { a: 1 },
      "the description",
      "billing",
      "admin-user"
    );
    expect(upsertSettingMock).toHaveBeenCalledWith(
      "k1",
      { a: 1 },
      {
        description: "the description",
        category: "billing",
        updatedBy: "admin-user",
      }
    );
  });

  it("uses defaults when description/category/updatedBy are omitted", async () => {
    upsertSettingMock.mockResolvedValueOnce(undefined);
    await SettingsService.setSetting("k2", true);
    expect(upsertSettingMock).toHaveBeenCalledWith("k2", true, {
      description: "",
      category: "general",
      updatedBy: "system",
    });
  });
});

describe("SettingsService.clearCache", () => {
  it("is a no-op that just emits an info log (caching is disabled)", () => {
    SettingsService.clearCache();
    expect(loggerInfo).toHaveBeenCalledTimes(1);
    expect(loggerInfo.mock.calls[0][0]).toMatch(/Cache clear requested.*no caching/);
  });
});

describe("SettingsService.getAllSettings", () => {
  it("maps the underlying listSettings docs to a flat array of (key, value, …) entries", async () => {
    listSettingsMock.mockResolvedValueOnce([
      {
        key: "a",
        value: 1,
        description: "desc-a",
        category: "billing",
        updatedAt: new Date("2026-01-01"),
        updatedBy: "admin",
      },
      {
        key: "b",
        value: "two",
        description: undefined,
        category: undefined,
        updatedAt: undefined,
        updatedBy: undefined,
      },
    ]);
    const out = await SettingsService.getAllSettings();
    expect(out).toEqual([
      {
        key: "a",
        value: 1,
        description: "desc-a",
        category: "billing",
        updatedAt: new Date("2026-01-01"),
        updatedBy: "admin",
      },
      {
        key: "b",
        value: "two",
        description: undefined,
        category: undefined,
        updatedAt: undefined,
        updatedBy: undefined,
      },
    ]);
  });

  it("returns [] when the underlying collection is empty", async () => {
    listSettingsMock.mockResolvedValueOnce([]);
    expect(await SettingsService.getAllSettings()).toEqual([]);
  });
});
