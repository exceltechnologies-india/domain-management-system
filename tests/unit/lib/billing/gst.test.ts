/**
 * Tests for `@/lib/billing/gst` — the primary invoicing engine's GST
 * calculation, independent of lib/zohobooks.ts. Pins:
 *  - intra-state (same org/customer state) -> CGST+SGST split, no IGST
 *  - inter-state (different state) -> IGST only, no CGST/SGST
 *  - no customer state on file -> treated as intra-state (conservative
 *    default, matches the existing Zoho-integration fallback behaviour)
 *  - case/whitespace-insensitive state comparison
 *  - taxableValue back-computed from a GST-inclusive gross amount, and
 *    cgst+sgst+igst always reconciles exactly to totalTax (no paisa drift)
 *  - placeOfSupply falls back to "N/A" when the customer has no state
 */
import { describe, expect, it } from "vitest";
import {
  computeGstBreakdown,
  isInterStateSupply,
  placeOfSupply,
} from "@/lib/billing/gst";

describe("isInterStateSupply", () => {
  it("is false for the same state", () => {
    expect(isInterStateSupply("Delhi", "Delhi")).toBe(false);
  });

  it("is case/whitespace-insensitive", () => {
    expect(isInterStateSupply("Delhi", "  delhi  ")).toBe(false);
    expect(isInterStateSupply("DELHI", "delhi")).toBe(false);
  });

  it("is true for a different state", () => {
    expect(isInterStateSupply("Delhi", "Maharashtra")).toBe(true);
  });

  it("treats a missing customer state as intra-state", () => {
    expect(isInterStateSupply("Delhi", undefined)).toBe(false);
    expect(isInterStateSupply("Delhi", null)).toBe(false);
    expect(isInterStateSupply("Delhi", "")).toBe(false);
  });
});

describe("placeOfSupply", () => {
  it("returns the trimmed customer state", () => {
    expect(placeOfSupply("  Maharashtra  ")).toBe("Maharashtra");
  });

  it("falls back to N/A when absent", () => {
    expect(placeOfSupply(undefined)).toBe("N/A");
    expect(placeOfSupply("")).toBe("N/A");
  });
});

describe("computeGstBreakdown", () => {
  it("splits intra-state 18% GST into equal CGST+SGST, no IGST", () => {
    const result = computeGstBreakdown(1180, "Delhi", "Delhi", 18);
    expect(result.isInterState).toBe(false);
    expect(result.taxableValue).toBe(1000);
    expect(result.totalTax).toBe(180);
    expect(result.cgst).toBe(90);
    expect(result.sgst).toBe(90);
    expect(result.igst).toBe(0);
    expect(result.totalAmount).toBe(1180);
  });

  it("charges IGST only for an inter-state supply", () => {
    const result = computeGstBreakdown(1180, "Delhi", "Maharashtra", 18);
    expect(result.isInterState).toBe(true);
    expect(result.igst).toBe(180);
    expect(result.cgst).toBe(0);
    expect(result.sgst).toBe(0);
  });

  it("always reconciles cgst+sgst+igst to totalTax exactly, even with rounding", () => {
    // 599 at 18% doesn't divide evenly - exercises the round-then-remainder
    // sgst calc (totalTax - cgst) rather than halving totalTax twice.
    const result = computeGstBreakdown(599, "Delhi", "Delhi", 18);
    expect(result.cgst + result.sgst).toBeCloseTo(result.totalTax, 2);
    expect(result.taxableValue + result.totalTax).toBeCloseTo(result.totalAmount, 2);
  });

  it("defaults to 18% when no rate is given", () => {
    const result = computeGstBreakdown(1180, "Delhi", "Delhi");
    expect(result.gstRate).toBe(18);
  });
});
