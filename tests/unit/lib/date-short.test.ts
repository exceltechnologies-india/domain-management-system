/** formatIndianShortDate — "22 Oct 2026" in IST (10 Oct 2026). */
import { describe, it, expect } from "vitest";
import { formatIndianShortDate, formatDateIN } from "@/lib/dateUtils";

describe("formatIndianShortDate", () => {
  it("writes DD MMM YYYY in IST, with Sep (not Sept)", () => {
    expect(formatIndianShortDate("2026-10-22T06:00:00Z")).toBe("22 Oct 2026");
    expect(formatIndianShortDate("2026-09-05T06:00:00Z")).toBe("5 Sep 2026");
    expect(formatIndianShortDate("2026-12-31T20:00:00Z")).toBe("1 Jan 2027"); // 01:30 IST next day
    expect(formatIndianShortDate(null)).toBe("-");
    expect(formatIndianShortDate("not a date")).toBe("-");
  });
  it("is what the customer dashboard uses", () => {
    expect(formatDateIN("2026-10-22T06:00:00Z")).toBe("22 Oct 2026");
  });
});
