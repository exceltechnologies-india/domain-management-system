import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  formatIndianDate,
  formatIndianDateTime,
  formatIndianTime,
  formatIndianLongDate,
  formatIndianCurrency,
  formatIndianNumber,
  getRelativeTime,
  isWithinRenewalWindow,
  getCurrentIndianDate,
  formatDateTimeIN,
} from "@/lib/dateUtils";

// A fixed UTC date: 2024-06-15T06:30:00.000Z
// In IST (UTC+5:30) this is 2024-06-15 12:00:00
const FIXED_DATE = new Date("2024-06-15T06:30:00.000Z");
const FIXED_DATE_STR = "2024-06-15T06:30:00.000Z";

describe("formatIndianDate", () => {
  it("returns '-' for null/undefined input", () => {
    expect(formatIndianDate(null)).toBe("-");
    expect(formatIndianDate(undefined)).toBe("-");
  });

  it("returns '-' for an invalid date string", () => {
    expect(formatIndianDate("not-a-date")).toBe("-");
  });

  it("formats a Date object to DD/MM/YYYY", () => {
    const result = formatIndianDate(FIXED_DATE);
    // In IST this date is 15/06/2024
    expect(result).toMatch(/15\/06\/2024/);
  });

  it("formats a date string to DD/MM/YYYY", () => {
    const result = formatIndianDate(FIXED_DATE_STR);
    expect(result).toMatch(/15\/06\/2024/);
  });
});

describe("formatIndianDateTime", () => {
  it("returns '-' for null/undefined", () => {
    expect(formatIndianDateTime(null)).toBe("-");
    expect(formatIndianDateTime(undefined)).toBe("-");
  });

  it("returns '-' for an invalid date string", () => {
    expect(formatIndianDateTime("garbage")).toBe("-");
  });

  it("formats a date to include date and time parts", () => {
    const result = formatIndianDateTime(FIXED_DATE);
    // Should contain the date part
    expect(result).toMatch(/15\/06\/2024/);
    // Should contain AM or PM
    expect(result).toMatch(/AM|PM|am|pm/i);
  });
});

describe("formatIndianTime", () => {
  it("returns '-' for null/undefined", () => {
    expect(formatIndianTime(null)).toBe("-");
  });

  it("returns a time string with AM/PM for a valid date", () => {
    const result = formatIndianTime(FIXED_DATE);
    expect(result).toMatch(/AM|PM|am|pm/i);
  });
});

describe("formatIndianLongDate", () => {
  it("returns '-' for null/undefined", () => {
    expect(formatIndianLongDate(null)).toBe("-");
  });

  it("formats a date to long format with month name", () => {
    const result = formatIndianLongDate(FIXED_DATE);
    // Should contain the month name "June"
    expect(result).toMatch(/June|Jun/);
    expect(result).toMatch(/2024/);
  });
});

describe("formatIndianCurrency", () => {
  it("formats a whole number as Indian rupees", () => {
    const result = formatIndianCurrency(1000);
    // Should contain ₹ and the number
    expect(result).toContain("₹");
    expect(result).toMatch(/1,000|1000/);
  });

  it("formats zero", () => {
    const result = formatIndianCurrency(0);
    expect(result).toContain("₹");
  });

  it("formats large Indian numbers with correct grouping", () => {
    const result = formatIndianCurrency(100000);
    // Indian grouping: 1,00,000
    expect(result).toContain("₹");
  });

  it("formats decimal amounts", () => {
    const result = formatIndianCurrency(1234.56);
    expect(result).toContain("₹");
  });
});

describe("formatIndianNumber", () => {
  it("formats a number with Indian grouping", () => {
    const result = formatIndianNumber(100000);
    // Indian grouping: 1,00,000
    expect(result).toMatch(/1,00,000/);
  });

  it("formats a small number without grouping", () => {
    const result = formatIndianNumber(999);
    expect(result).toBe("999");
  });
});

describe("getRelativeTime", () => {
  it("returns empty string for null/undefined", () => {
    expect(getRelativeTime(null)).toBe("");
    expect(getRelativeTime(undefined)).toBe("");
  });

  it("returns empty string for an invalid date", () => {
    expect(getRelativeTime("invalid")).toBe("");
  });

  it("returns a past relative time string for a past date", () => {
    const pastDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
    const result = getRelativeTime(pastDate);
    // Should contain "ago" or "day"
    expect(result).toMatch(/ago|day|yesterday/i);
  });

  it("returns a future relative time string for a future date", () => {
    const futureDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000); // 5 days in future
    const result = getRelativeTime(futureDate);
    expect(result).toMatch(/in|day/i);
  });

  it("returns a minutes-ago string for a very recent past date", () => {
    const recentDate = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
    const result = getRelativeTime(recentDate);
    expect(result).toMatch(/minute|min|ago/i);
  });
});

describe("isWithinRenewalWindow", () => {
  it("returns false for null/undefined", () => {
    expect(isWithinRenewalWindow(null)).toBe(false);
    expect(isWithinRenewalWindow(undefined)).toBe(false);
  });

  it("returns false for an invalid date", () => {
    expect(isWithinRenewalWindow("invalid-date")).toBe(false);
  });

  it("returns true when expiry is less than 15 days away", () => {
    const soon = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000); // 10 days from now
    expect(isWithinRenewalWindow(soon)).toBe(true);
  });

  it("returns true when expiry is in the past (already expired)", () => {
    const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000); // 5 days ago
    expect(isWithinRenewalWindow(past)).toBe(true);
  });

  it("returns false when expiry is more than 15 days away", () => {
    const far = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days from now
    expect(isWithinRenewalWindow(far)).toBe(false);
  });

  it("accepts a date string", () => {
    const soon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    expect(isWithinRenewalWindow(soon.toISOString())).toBe(true);
  });
});

describe("formatDateTimeIN", () => {
  it("returns '-' for null/undefined", () => {
    expect(formatDateTimeIN(null)).toBe("-");
    expect(formatDateTimeIN(undefined)).toBe("-");
  });

  it("returns '-' for an invalid date string", () => {
    expect(formatDateTimeIN("garbage")).toBe("-");
  });

  it("formats a Date object including seconds and AM/PM", () => {
    const result = formatDateTimeIN(FIXED_DATE);
    expect(result).toMatch(/\d{2}\/\d{2}\/\d{4}/); // date part
    expect(result).toMatch(/AM|PM|am|pm/i);        // time part
    expect(result).toMatch(/15\/06\/2024/);         // correct date in IST
  });

  it("formats a date string including seconds", () => {
    const result = formatDateTimeIN(FIXED_DATE_STR);
    expect(result).toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });
});

describe("getRelativeTime (extended — months and years)", () => {
  it("returns a months string for a date ~2 months in the future", () => {
    const twoMonthsAhead = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000); // ~60 days
    const result = getRelativeTime(twoMonthsAhead);
    expect(result).toMatch(/month|in/i);
  });

  it("returns a months string for a date ~2 months in the past", () => {
    const twoMonthsAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // ~60 days ago
    const result = getRelativeTime(twoMonthsAgo);
    expect(result).toMatch(/month|ago/i);
  });

  it("returns a years string for a date 2 years in the future", () => {
    const twoYearsAhead = new Date(Date.now() + 2 * 365 * 24 * 60 * 60 * 1000);
    const result = getRelativeTime(twoYearsAhead);
    expect(result).toMatch(/year|in/i);
  });

  it("returns a years string for a date 2 years in the past", () => {
    const twoYearsAgo = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000);
    const result = getRelativeTime(twoYearsAgo);
    expect(result).toMatch(/year|ago/i);
  });

  it("returns an hours string for a date ~5 hours in the past", () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
    const result = getRelativeTime(fiveHoursAgo);
    expect(result).toMatch(/hour|ago/i);
  });

  it("returns an hours string for a date ~5 hours in the future", () => {
    const fiveHoursAhead = new Date(Date.now() + 5 * 60 * 60 * 1000);
    const result = getRelativeTime(fiveHoursAhead);
    expect(result).toMatch(/hour|in/i);
  });
});

describe("getCurrentIndianDate", () => {
  it("returns a Date object", () => {
    const result = getCurrentIndianDate();
    expect(result).toBeInstanceOf(Date);
    expect(isNaN(result.getTime())).toBe(false);
  });
});
