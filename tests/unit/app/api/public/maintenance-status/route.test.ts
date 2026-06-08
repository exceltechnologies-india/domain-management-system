/**
 * Tests for `app/api/public/maintenance-status/route.ts` (slice 7gm,
 * part 2). Public endpoint that tells the front-end whether the
 * site is in maintenance mode. The behaviour to pin:
 *
 *  - **Fail-open on error**: if the DB read throws, return enabled
 *    false. Anti-lockout: a DB blip must NOT make the entire app
 *    show a maintenance banner.
 *  - **Auto-expire**: if a scheduledEnd is set and has passed,
 *    upsertSetting flips enabled to false AND the response reports
 *    enabled false. The maintenance window expires automatically
 *    instead of needing an admin to manually flip it.
 *  - **Missing setting**: return `{ enabled:false, message:'',
 *    scheduledEnd:null }` (default state for first-time setup)
 *  - **Active mode passes through**: enabled true + message +
 *    scheduledEnd preserved
 *  - **Falsy-message normalization**: undefined message → empty
 *    string (so the front-end can always render `message` without
 *    null-checking)
 *  - **scheduledEnd in the future** does NOT trigger auto-expire
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const connectToDatabase = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/mongoose", () => ({ connectToDatabase }));

const getSettingValue = vi.hoisted(() => vi.fn());
const upsertSetting = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/settings", () => ({
  getSettingValue,
  upsertSetting,
}));

vi.unmock("next/server");
const { NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextResponse }));

import { GET } from "@/app/api/public/maintenance-status/route";

const NOW = new Date("2026-06-08T12:00:00.000Z").getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  connectToDatabase.mockClear().mockResolvedValue(undefined);
  getSettingValue.mockReset();
  upsertSetting.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET — missing setting returns default-off shape", () => {
  it("setting null → { enabled:false, message:'', scheduledEnd:null }", async () => {
    getSettingValue.mockResolvedValueOnce(null);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      enabled: false,
      message: "",
      scheduledEnd: null,
    });
  });
});

describe("GET — active maintenance passes through", () => {
  it("enabled true with message + future scheduledEnd → all preserved", async () => {
    getSettingValue.mockResolvedValueOnce({
      enabled: true,
      message: "Upgrading in progress",
      scheduledEnd: "2026-06-09T00:00:00.000Z", // future
    });
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({
      enabled: true,
      message: "Upgrading in progress",
      scheduledEnd: "2026-06-09T00:00:00.000Z",
    });
    // Future end → no upsert (don't auto-expire)
    expect(upsertSetting).not.toHaveBeenCalled();
  });

  it("undefined message normalised to '' (anti-null-check on the front-end)", async () => {
    getSettingValue.mockResolvedValueOnce({
      enabled: true,
      message: undefined,
      scheduledEnd: null,
    });
    const res = await GET();
    const body = await res.json();
    expect(body.message).toBe("");
  });
});

describe("GET — auto-expire on past scheduledEnd", () => {
  it("enabled true + scheduledEnd already passed → upsert disables + response enabled=false", async () => {
    getSettingValue.mockResolvedValueOnce({
      enabled: true,
      message: "Old window",
      scheduledEnd: "2026-06-08T11:00:00.000Z", // 1h ago
    });
    upsertSetting.mockResolvedValueOnce(undefined);

    const res = await GET();
    const body = await res.json();
    expect(body.enabled).toBe(false);
    expect(upsertSetting).toHaveBeenCalledWith(
      "maintenance_mode",
      expect.objectContaining({ enabled: false })
    );
  });

  it("scheduledEnd === now is considered expired (<=, not <)", async () => {
    getSettingValue.mockResolvedValueOnce({
      enabled: true,
      message: "Edge case",
      scheduledEnd: new Date(NOW).toISOString(), // exactly now
    });
    upsertSetting.mockResolvedValueOnce(undefined);

    const res = await GET();
    const body = await res.json();
    expect(body.enabled).toBe(false);
    expect(upsertSetting).toHaveBeenCalled();
  });
});

describe("GET — fail-open on error (anti-lockout)", () => {
  it("connectToDatabase throws → return enabled=false (NOT an error response)", async () => {
    connectToDatabase.mockRejectedValueOnce(new Error("DB blew up"));
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(false);
    expect(body.message).toBe("");
  });

  it("getSettingValue throws → return enabled=false", async () => {
    getSettingValue.mockRejectedValueOnce(new Error("settings DB error"));
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(false);
  });
});
