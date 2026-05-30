/**
 * Hook tests for `useDomainPricing` (rescan-4 M14 — domain-search hooks).
 * Thin formatter around Intl.NumberFormat. Pins:
 *  - Default INR currency formatting with ₹ glyph + Indian-locale grouping
 *  - Custom currency override (USD)
 *  - Zero fraction digits (no decimals)
 */
import { renderHook } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { useDomainPricing } from "@/components/domain-search/hooks/useDomainPricing";

describe("useDomainPricing", () => {
  it("formats INR with ₹ glyph + Indian-locale grouping (no decimals)", () => {
    const { result } = renderHook(() => useDomainPricing());
    expect(result.current.formatPrice(1234)).toMatch(/₹\s*1,234/);
    // 100,000 grouped in the Indian system → "1,00,000"
    expect(result.current.formatPrice(100000)).toMatch(/1,00,000/);
  });

  it("custom currency override is honoured", () => {
    const { result } = renderHook(() => useDomainPricing());
    const out = result.current.formatPrice(999, "USD");
    // ICU may render USD as 'US$' or '$' depending on the runtime. Both are
    // valid; assert by the leading dollar sign + grouped digits.
    expect(out).toMatch(/\$\s*999/);
  });

  it("zero fraction digits — never renders decimals", () => {
    const { result } = renderHook(() => useDomainPricing());
    expect(result.current.formatPrice(1234.99)).not.toMatch(/\./);
  });
});
