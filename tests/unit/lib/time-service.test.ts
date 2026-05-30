/**
 * Tests for `@/lib/time-service` (rescan-4 slice 7df).
 * The simulated-time helper used by the lifecycle/scheduler tests
 * (dev/staging only — never in production). Pins the resolution
 * priority:
 *   1. Explicit parameter override
 *   2. (in dev or with ENABLE_TIME_SIMULATION=true) x-simulated-time header
 *   3. (in dev or with ENABLE_TIME_SIMULATION=true) SIMULATED_TIME env
 *   4. Real `new Date()`
 *
 * In production (without ENABLE_TIME_SIMULATION), 2+3 are skipped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TimeService } from "@/lib/time-service";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-30T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("TimeService.now", () => {
  it("explicit parameter wins over everything (string)", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SIMULATED_TIME", "2099-01-01");
    expect(TimeService.now(null, "2030-06-15").toISOString()).toBe(
      new Date("2030-06-15").toISOString()
    );
  });

  it("explicit parameter wins over everything (Date)", () => {
    const d = new Date("2031-07-01");
    expect(TimeService.now(null, d).toISOString()).toBe(d.toISOString());
  });

  it("in production with no simulation env → returns real new Date()", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENABLE_TIME_SIMULATION", "false");
    vi.stubEnv("SIMULATED_TIME", "2099-01-01"); // would be ignored
    const result = TimeService.now();
    expect(result.toISOString()).toBe("2026-05-30T12:00:00.000Z");
  });

  it("in development the x-simulated-time header is honoured", () => {
    vi.stubEnv("NODE_ENV", "development");
    const fakeReq = {
      headers: new Headers({ "x-simulated-time": "2030-03-15T08:00:00Z" }),
    } as unknown as Request;
    expect(TimeService.now(fakeReq).toISOString()).toBe("2030-03-15T08:00:00.000Z");
  });

  it("in development the SIMULATED_TIME env var is honoured (no header)", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SIMULATED_TIME", "2030-04-15T09:00:00Z");
    expect(TimeService.now().toISOString()).toBe("2030-04-15T09:00:00.000Z");
  });

  it("ENABLE_TIME_SIMULATION=true overrides the production guard", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENABLE_TIME_SIMULATION", "true");
    vi.stubEnv("SIMULATED_TIME", "2030-05-15T10:00:00Z");
    expect(TimeService.now().toISOString()).toBe("2030-05-15T10:00:00.000Z");
  });

  it("no simulation + no override → returns real now()", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(TimeService.now().toISOString()).toBe("2026-05-30T12:00:00.000Z");
  });
});

describe("TimeService.daysUntil", () => {
  it("future date → positive whole days", () => {
    const now = new Date("2026-05-30T00:00:00Z");
    const expiry = new Date("2026-06-09T00:00:00Z");
    expect(TimeService.daysUntil(expiry, now)).toBe(10);
  });

  it("same day → 0", () => {
    const d = new Date("2026-05-30T00:00:00Z");
    expect(TimeService.daysUntil(d, d)).toBe(0);
  });

  it("past date → negative", () => {
    const now = new Date("2026-05-30T00:00:00Z");
    const expiry = new Date("2026-05-25T00:00:00Z");
    expect(TimeService.daysUntil(expiry, now)).toBe(-5);
  });

  it("uses floor — partial days do not round up", () => {
    const now = new Date("2026-05-30T00:00:00Z");
    // 9 days + 23 hours later → still 9 whole days
    const expiry = new Date("2026-06-07T23:00:00Z");
    expect(TimeService.daysUntil(expiry, now)).toBe(8);
  });
});
