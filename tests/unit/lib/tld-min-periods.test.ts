/**
 * Tests for `@/lib/tld-min-periods` (rescan-4 slice 7dd).
 * Thin backwards-compat wrapper around the central TLD policy registry
 * at `@/lib/tld-policies`. Pins:
 *  - TLD_MIN_PERIODS filters TLD_POLICIES down to TLDs with minYears > 1
 *  - getMinRegistrationPeriod delegates to getMinYears
 */
import { describe, it, expect } from "vitest";
import { TLD_MIN_PERIODS, getMinRegistrationPeriod } from "@/lib/tld-min-periods";
import { getMinYears, TLD_POLICIES } from "@/lib/tld-policies";

describe("TLD_MIN_PERIODS map", () => {
  it("only includes TLDs whose minYears is a number > 1", () => {
    for (const [tld, period] of Object.entries(TLD_MIN_PERIODS)) {
      expect(typeof period).toBe("number");
      expect(period).toBeGreaterThan(1);
      // The same TLD must exist in TLD_POLICIES with that exact minYears.
      const policy = TLD_POLICIES[tld];
      expect(policy?.minYears).toBe(period);
    }
  });

  it("excludes TLDs with minYears=1 or undefined", () => {
    for (const [tld, policy] of Object.entries(TLD_POLICIES)) {
      if (policy.minYears === undefined || policy.minYears <= 1) {
        expect(TLD_MIN_PERIODS).not.toHaveProperty(tld);
      }
    }
  });
});

describe("getMinRegistrationPeriod", () => {
  it("delegates to getMinYears (same return value for the same domain)", () => {
    const samples = ["example.com", "example.in", "example.au", "example.uk"];
    for (const domain of samples) {
      expect(getMinRegistrationPeriod(domain)).toBe(getMinYears(domain));
    }
  });

  it("returns a positive integer for any well-formed domain", () => {
    const min = getMinRegistrationPeriod("example.com");
    expect(min).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(min)).toBe(true);
  });
});
