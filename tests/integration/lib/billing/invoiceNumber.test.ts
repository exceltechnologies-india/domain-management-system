/**
 * Integration test for `@/lib/billing/invoiceNumber` allocateInvoiceNumber.
 *
 * Hits a real in-memory MongoDB so the `$inc`-based atomicity claim is
 * actually exercised, not assumed — the whole point of the Counter model is
 * that concurrent callers allocating for the same fiscal year never collide
 * or skip a number (GST requires a gapless sequence).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { clearAllCollections } from "../../setup";
import { allocateInvoiceNumber } from "@/lib/billing/invoiceNumber";

beforeEach(clearAllCollections);

describe("allocateInvoiceNumber", () => {
  it("starts a fresh fiscal-year series at 00001", async () => {
    const number = await allocateInvoiceNumber(new Date("2026-08-15"));
    expect(number).toBe("TI/2026-27/00001");
  });

  it("increments sequentially within the same fiscal year", async () => {
    const a = await allocateInvoiceNumber(new Date("2026-08-15"));
    const b = await allocateInvoiceNumber(new Date("2026-09-01"));
    const c = await allocateInvoiceNumber(new Date("2027-03-31"));
    expect([a, b, c]).toEqual([
      "TI/2026-27/00001",
      "TI/2026-27/00002",
      "TI/2026-27/00003",
    ]);
  });

  it("starts a new series when the fiscal year rolls over", async () => {
    await allocateInvoiceNumber(new Date("2027-03-31")); // FY 2026-27, seq 1
    const firstOfNewYear = await allocateInvoiceNumber(new Date("2027-04-01")); // FY 2027-28
    expect(firstOfNewYear).toBe("TI/2027-28/00001");
  });

  it("never hands out a duplicate number under concurrent allocation", async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, () => allocateInvoiceNumber(new Date("2026-08-15")))
    );
    expect(new Set(results).size).toBe(25);
    expect(results).toContain("TI/2026-27/00001");
    expect(results).toContain("TI/2026-27/00025");
  });
});
