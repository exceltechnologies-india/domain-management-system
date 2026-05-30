/**
 * Tests for `@/lib/hosting-dates` (rescan-4 slice 7df).
 * Centralised hosting date math. Pins:
 *  - calculateHostingDates with default unit='months' uses setMonth (so
 *    leap-day + year-rollover math is correct)
 *  - 'days' unit uses setDate; 'minutes' unit uses setMinutes
 *  - registeredAt = current time (the same Date object returned by
 *    getCurrentDate at call time)
 *  - validateRegistrationPeriod: only 12 passes through, everything
 *    else defaults to 1
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  calculateHostingDates,
  validateRegistrationPeriod,
} from "@/lib/hosting-dates";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-30T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("calculateHostingDates", () => {
  it("default unit='months' — registeredAt=now, expiresAt = now + N months", () => {
    const { registeredAt, expiresAt } = calculateHostingDates(12);
    expect(registeredAt.toISOString()).toBe("2026-05-30T12:00:00.000Z");
    expect(expiresAt.toISOString()).toBe("2027-05-30T12:00:00.000Z");
  });

  it("unit='months' — 1-month period", () => {
    const { expiresAt } = calculateHostingDates(1);
    expect(expiresAt.toISOString()).toBe("2026-06-30T12:00:00.000Z");
  });

  it("unit='days' uses setDate", () => {
    const { expiresAt } = calculateHostingDates(7, "days");
    expect(expiresAt.toISOString()).toBe("2026-06-06T12:00:00.000Z");
  });

  it("unit='minutes' uses setMinutes (used by short-duration test plans)", () => {
    const { expiresAt } = calculateHostingDates(45, "minutes");
    expect(expiresAt.toISOString()).toBe("2026-05-30T12:45:00.000Z");
  });

  it("registeredAt and expiresAt are different Date objects (no aliasing)", () => {
    const { registeredAt, expiresAt } = calculateHostingDates(1);
    expect(registeredAt).not.toBe(expiresAt);
  });
});

describe("validateRegistrationPeriod", () => {
  it("12 passes through unchanged", () => {
    expect(validateRegistrationPeriod(12)).toBe(12);
  });

  it("1 → 1 (default)", () => {
    expect(validateRegistrationPeriod(1)).toBe(1);
  });

  it("undefined → 1", () => {
    expect(validateRegistrationPeriod(undefined)).toBe(1);
  });

  it.each([0, 2, 3, 6, 24, -1])("%d → 1 (only 12 is allowed besides default)", (n) => {
    expect(validateRegistrationPeriod(n)).toBe(1);
  });
});
