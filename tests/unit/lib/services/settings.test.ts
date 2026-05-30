/**
 * Tests for `@/lib/services/settings` (rescan-4 slice 7ds).
 * Centralised reads/writes for the Settings key-value collection.
 * Pins:
 *  - getSettingValue swallows errors → returns defaultValue
 *  - getSetting delegates without try/catch (caller handles)
 *  - getSettingsMap: empty input → empty map (no DB call)
 *  - getSettingsMap returns a {key:value} map (one round-trip)
 *  - listSettings sorts by category then key
 *  - upsertSetting builds the right $set + upsert:true
 *  - description/category are only included when supplied (undefined omitted)
 *  - deleteSetting calls deleteOne({key})
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const connectDBMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDBMock }));

const findOneMock = vi.hoisted(() => vi.fn());
const findMock = vi.hoisted(() => vi.fn());
const findOneAndUpdateMock = vi.hoisted(() => vi.fn());
const deleteOneMock = vi.hoisted(() => vi.fn());
vi.mock("@/models/Settings", () => ({
  default: {
    findOne: findOneMock,
    find: findMock,
    findOneAndUpdate: findOneAndUpdateMock,
    deleteOne: deleteOneMock,
  },
}));

const loggerError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { error: loggerError, info: vi.fn(), warn: vi.fn() },
}));

import {
  getSettingValue,
  getSetting,
  getSettingsMap,
  listSettings,
  upsertSetting,
  deleteSetting,
} from "@/lib/services/settings";

beforeEach(() => {
  connectDBMock.mockReset();
  findOneMock.mockReset();
  findMock.mockReset();
  findOneAndUpdateMock.mockReset();
  deleteOneMock.mockReset();
  loggerError.mockReset();
});

describe("getSettingValue", () => {
  it("returns the doc's value field on success", async () => {
    findOneMock.mockReturnValue({
      lean: vi.fn().mockResolvedValue({ value: "the-value" }),
    });
    const result = await getSettingValue<string>("k");
    expect(connectDBMock).toHaveBeenCalled();
    expect(findOneMock).toHaveBeenCalledWith({ key: "k" });
    expect(result).toBe("the-value");
  });

  it("returns defaultValue when the row is missing", async () => {
    findOneMock.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
    expect(await getSettingValue("missing", "default")).toBe("default");
    expect(await getSettingValue("missing")).toBeNull();
  });

  it("swallows DB errors → returns defaultValue + logs", async () => {
    findOneMock.mockImplementation(() => {
      throw new Error("DB blip");
    });
    expect(await getSettingValue("k", 42)).toBe(42);
    expect(loggerError).toHaveBeenCalled();
  });
});

describe("getSetting", () => {
  it("returns the full doc with metadata fields", async () => {
    findOneMock.mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        key: "k",
        value: 1,
        description: "d",
        category: "billing",
      }),
    });
    const doc = await getSetting("k");
    expect(doc).toMatchObject({ key: "k", value: 1, description: "d", category: "billing" });
  });

  it("returns null when the row is missing", async () => {
    findOneMock.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
    expect(await getSetting("missing")).toBeNull();
  });
});

describe("getSettingsMap", () => {
  it("empty input → empty map (no DB call)", async () => {
    expect(await getSettingsMap([])).toEqual({});
    expect(connectDBMock).not.toHaveBeenCalled();
    expect(findMock).not.toHaveBeenCalled();
  });

  it("maps docs by key (one round-trip via $in)", async () => {
    findMock.mockReturnValue({
      lean: vi.fn().mockResolvedValue([
        { key: "a", value: 1 },
        { key: "b", value: "two" },
      ]),
    });
    const map = await getSettingsMap(["a", "b", "c"]);
    expect(findMock).toHaveBeenCalledWith({ key: { $in: ["a", "b", "c"] } });
    expect(map).toEqual({ a: 1, b: "two" });
  });
});

describe("listSettings", () => {
  it("sorts by category then key", async () => {
    const sortMock = vi.fn().mockReturnThis();
    const leanMock = vi.fn().mockResolvedValue([{ key: "k", value: 1 }]);
    findMock.mockReturnValue({ sort: sortMock, lean: leanMock });
    sortMock.mockReturnValue({ lean: leanMock });
    const docs = await listSettings();
    expect(findMock).toHaveBeenCalledWith({});
    expect(sortMock).toHaveBeenCalledWith({ category: 1, key: 1 });
    expect(docs).toEqual([{ key: "k", value: 1 }]);
  });
});

describe("upsertSetting", () => {
  it("builds the upsert with default updatedBy='system' when not supplied", async () => {
    findOneAndUpdateMock.mockResolvedValueOnce({});
    await upsertSetting("k", 42);
    const [filter, update, opts] = findOneAndUpdateMock.mock.calls[0];
    expect(filter).toEqual({ key: "k" });
    expect(opts).toEqual({ upsert: true });
    expect(update).toMatchObject({
      key: "k",
      value: 42,
      updatedBy: "system",
    });
    expect(update.updatedAt).toBeInstanceOf(Date);
    // description + category are NOT included when not supplied.
    expect(update.description).toBeUndefined();
    expect(update.category).toBeUndefined();
  });

  it("includes description + category + updatedBy when supplied", async () => {
    findOneAndUpdateMock.mockResolvedValueOnce({});
    await upsertSetting("k", { x: 1 }, {
      description: "the desc",
      category: "billing",
      updatedBy: "admin-42",
    });
    const update = findOneAndUpdateMock.mock.calls[0][1];
    expect(update).toMatchObject({
      key: "k",
      value: { x: 1 },
      description: "the desc",
      category: "billing",
      updatedBy: "admin-42",
    });
  });
});

describe("deleteSetting", () => {
  it("calls deleteOne({key})", async () => {
    deleteOneMock.mockResolvedValueOnce({ deletedCount: 1 });
    await deleteSetting("k");
    expect(deleteOneMock).toHaveBeenCalledWith({ key: "k" });
  });
});
