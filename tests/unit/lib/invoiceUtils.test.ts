import { describe, it, expect } from "vitest";
import {
  SAC_CODE,
  calculateSubscriptionEndDate,
  formatSubscriptionPeriod,
  formatQuantityText,
} from "@/lib/invoiceUtils";

describe("SAC_CODE", () => {
  it("is the correct Service Accounting Code for domain/hosting services", () => {
    expect(SAC_CODE).toBe("998319");
  });
});

describe("calculateSubscriptionEndDate", () => {
  const start = new Date("2024-01-01");

  it("adds 1 year and subtracts 1 day (01/01/2024 → 31/12/2024)", () => {
    const end = calculateSubscriptionEndDate(start, 1, "years");
    expect(end.getFullYear()).toBe(2024);
    expect(end.getMonth()).toBe(11); // December = 11
    expect(end.getDate()).toBe(31);
  });

  it("adds 2 years correctly (01/01/2024 → 31/12/2025)", () => {
    const end = calculateSubscriptionEndDate(start, 2, "years");
    expect(end.getFullYear()).toBe(2025);
    expect(end.getMonth()).toBe(11);
    expect(end.getDate()).toBe(31);
  });

  it("adds months and subtracts 1 day (01/01/2024 + 1 month → 31/01/2024)", () => {
    const end = calculateSubscriptionEndDate(start, 1, "months");
    expect(end.getFullYear()).toBe(2024);
    expect(end.getMonth()).toBe(0); // January = 0
    expect(end.getDate()).toBe(31);
  });

  it("adds multiple months correctly", () => {
    const end = calculateSubscriptionEndDate(start, 3, "months");
    // 01/01 + 3 months = 01/04, then -1 day = 31/03
    expect(end.getMonth()).toBe(2); // March = 2
    expect(end.getDate()).toBe(31);
  });

  it("adds exactly 1 day (no -1 adjustment for 1-day unit)", () => {
    // For unit=days and duration=1, the function adds 1 day then skips the -1 subtraction.
    // So Jan 1 + 1 day = Jan 2 (the end date of a 1-day subscription starting Jan 1).
    const end = calculateSubscriptionEndDate(start, 1, "days");
    expect(end.getDate()).toBe(2); // Jan 1 + 1 day, no subtraction = Jan 2
    expect(end.getMonth()).toBe(0);
  });

  it("adds multiple days and subtracts 1", () => {
    const end = calculateSubscriptionEndDate(start, 7, "days");
    // 01/01 + 7 days = 08/01, then -1 = 07/01
    expect(end.getDate()).toBe(7);
  });

  it("defaults to 'years' when no unit is provided", () => {
    const end = calculateSubscriptionEndDate(start, 1);
    expect(end.getFullYear()).toBe(2024);
    expect(end.getMonth()).toBe(11);
  });
});

describe("formatSubscriptionPeriod", () => {
  const start = new Date("2024-01-01");

  it("formats 1-year period correctly", () => {
    const result = formatSubscriptionPeriod(start, 1, "years");
    expect(result).toContain("1 Year");
    expect(result).toContain("01/01/2024");
    expect(result).toContain("31/12/2024");
  });

  it("uses plural 'Years' for duration > 1", () => {
    const result = formatSubscriptionPeriod(start, 2, "years");
    expect(result).toContain("2 Years");
  });

  it("formats months with singular 'Month'", () => {
    const result = formatSubscriptionPeriod(start, 1, "months");
    expect(result).toContain("1 Month");
  });

  it("formats months with plural 'Months'", () => {
    const result = formatSubscriptionPeriod(start, 6, "months");
    expect(result).toContain("6 Months");
  });

  it("formats days with singular 'Day'", () => {
    const result = formatSubscriptionPeriod(start, 1, "days");
    expect(result).toContain("1 Day");
  });

  it("formats days with plural 'Days'", () => {
    const result = formatSubscriptionPeriod(start, 30, "days");
    expect(result).toContain("30 Days");
  });

  it("includes start and end dates in DD/MM/YYYY format", () => {
    const result = formatSubscriptionPeriod(start, 1, "years");
    // Format: "1 Year (01/01/2024 - 31/12/2024)"
    expect(result).toMatch(/\d{2}\/\d{2}\/\d{4} - \d{2}\/\d{2}\/\d{4}/);
  });
});

describe("formatQuantityText", () => {
  it("formats domain quantity with 'Year/s' suffix", () => {
    const result = formatQuantityText(1, "years", "domain");
    expect(result).toContain("Year/s");
    expect(result).toContain("1.00");
  });

  it("formats hosting quantity in months with 'Month/s' suffix", () => {
    const result = formatQuantityText(12, "months", "hosting");
    expect(result).toContain("Month/s");
    expect(result).toContain("12.00");
  });

  it("formats hosting quantity in days with 'Day/s' suffix", () => {
    const result = formatQuantityText(30, "days", "hosting");
    expect(result).toContain("Day/s");
    expect(result).toContain("30.00");
  });

  it("defaults to 'domain' item type (Year/s)", () => {
    // Default itemType is "domain"
    const result = formatQuantityText(2);
    expect(result).toContain("Year/s");
  });

  it("formats quantity to 2 decimal places", () => {
    const result = formatQuantityText(1, "years", "domain");
    expect(result).toMatch(/1\.00/);
  });
});
