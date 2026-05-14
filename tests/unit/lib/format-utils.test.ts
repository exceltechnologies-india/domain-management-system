import { describe, it, expect } from "vitest";
import { formatBytes } from "@/lib/format-utils";

describe("formatBytes", () => {
  // ── Null / edge cases ──────────────────────────────────────────────────────
  it("returns '0 B' for undefined", () => {
    expect(formatBytes(undefined as any)).toBe("0 B");
  });

  it("returns '0 B' for null", () => {
    expect(formatBytes(null as any)).toBe("0 B");
  });

  it("returns '0 B' for empty string", () => {
    expect(formatBytes("")).toBe("0 B");
  });

  it("returns '0 B' for zero bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("returns '0 B' for a non-numeric string", () => {
    expect(formatBytes("abc")).toBe("0 B");
  });

  // ── 'unlimited' string ─────────────────────────────────────────────────────
  it("returns 'Unlimited' for the string 'unlimited'", () => {
    expect(formatBytes("unlimited")).toBe("Unlimited");
    expect(formatBytes("UNLIMITED")).toBe("Unlimited");
  });

  // ── Byte unit (default) ────────────────────────────────────────────────────
  it("formats bytes correctly (< 1 KB)", () => {
    expect(formatBytes(500)).toBe("500 B");
  });

  it("formats exactly 1 KB", () => {
    expect(formatBytes(1024)).toBe("1 KB");
  });

  it("formats exactly 1 MB", () => {
    expect(formatBytes(1024 * 1024)).toBe("1 MB");
  });

  it("formats exactly 1 GB", () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1 GB");
  });

  it("formats fractional KB with default 2 decimals", () => {
    expect(formatBytes(1536)).toBe("1.5 KB"); // 1.5 KB = 1536 bytes
  });

  // ── Input unit conversion ──────────────────────────────────────────────────
  it("converts MB input to display correctly", () => {
    // 10 MB input → should display as '10 MB'
    expect(formatBytes(10, "MB")).toBe("10 MB");
  });

  it("converts GB input to display correctly", () => {
    expect(formatBytes(1, "GB")).toBe("1 GB");
  });

  it("converts KB input to display correctly", () => {
    expect(formatBytes(1024, "KB")).toBe("1 MB"); // 1024 KB = 1 MB
  });

  // ── Custom decimal places ──────────────────────────────────────────────────
  it("respects custom decimal places", () => {
    expect(formatBytes(1536, "B", 0)).toBe("2 KB"); // rounded to 0 decimals
    expect(formatBytes(1536, "B", 3)).toBe("1.5 KB"); // exact at 3 decimals
  });

  it("uses 0 decimals when negative decimals are passed", () => {
    // negative decimals → treated as 0
    expect(formatBytes(1024, "B", -1)).toBe("1 KB");
  });

  // ── String number input ────────────────────────────────────────────────────
  it("accepts a numeric string as input", () => {
    expect(formatBytes("1024")).toBe("1 KB");
  });
});
