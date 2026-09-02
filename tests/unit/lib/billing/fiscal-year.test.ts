/**
 * Tests for `fiscalYearLabel` in `@/lib/billing/invoiceNumber` — pure date
 * math, no DB. The atomic-allocation half (allocateInvoiceNumber, backed by
 * models/Counter) is covered by the integration suite at
 * tests/integration/lib/billing/invoiceNumber.test.ts since it needs a real
 * MongoDB to prove the $inc is race-free.
 *
 * Pin: Indian fiscal year runs 1 Apr - 31 Mar, so the label for any date in
 * Jan-Mar belongs to the fiscal year that STARTED the previous calendar year.
 */
import { describe, expect, it } from "vitest";
import { fiscalYearLabel } from "@/lib/billing/invoiceNumber";

describe("fiscalYearLabel", () => {
  it("labels a mid-year date with the year it's in", () => {
    expect(fiscalYearLabel(new Date("2026-08-15"))).toBe("2026-27");
  });

  it("labels a Jan-Mar date with the PREVIOUS calendar year (FY hasn't rolled yet)", () => {
    expect(fiscalYearLabel(new Date("2027-02-01"))).toBe("2026-27");
    expect(fiscalYearLabel(new Date("2027-03-31"))).toBe("2026-27");
  });

  it("rolls over exactly on 1 April", () => {
    expect(fiscalYearLabel(new Date("2027-04-01"))).toBe("2027-28");
  });

  it("zero-pads the short end-year", () => {
    expect(fiscalYearLabel(new Date("2099-05-01"))).toBe("2099-00");
  });
});
