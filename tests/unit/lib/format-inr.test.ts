/** lib/format-inr.ts — rupees with Indian grouping, paise only when present (9 Oct 2026). */
import { describe, it, expect } from "vitest";
import { formatINR } from "@/lib/format-inr";

describe("formatINR", () => {
  it("groups the Indian way and drops .00", () => {
    expect(formatINR(1770)).toBe("₹1,770");
    expect(formatINR(2788.34)).toBe("₹2,788.34");
    expect(formatINR(490644)).toBe("₹4,90,644");
    expect(formatINR(1018.3)).toBe("₹1,018.30");
    expect(formatINR(0)).toBe("₹0");
  });
});
