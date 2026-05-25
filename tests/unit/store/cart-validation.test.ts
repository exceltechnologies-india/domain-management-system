/**
 * Unit tests for the pure cart-item validation helpers extracted in
 * rescan-4 M14 slice 15. Pins:
 *   - the TLD-specific clamping window (min via tld-policies, max
 *     via getMaxYears for domains / 60 for hosting)
 *   - the legacy hosting-10 back-fix
 *   - the (domainName, itemType) dedup
 *
 * Uses real TLD policies (not mocked) so the test guards the contract
 * between `cart-validation.ts` and the actual policy registry.
 */
import { describe, expect, it } from "vitest";
import {
  clampRegistrationPeriod,
  validateAndCorrectCartItems,
} from "@/store/cart-validation";
import type { CartItem } from "@/lib/types";

const baseDomain = (overrides: Partial<CartItem> = {}): CartItem => ({
  domainName: "example.com",
  price: 999,
  currency: "INR",
  registrationPeriod: 1,
  itemType: "domain",
  ...overrides,
});

const baseHosting = (overrides: Partial<CartItem> = {}): CartItem => ({
  domainName: "example.com",
  price: 1500,
  currency: "INR",
  registrationPeriod: 1,
  itemType: "hosting",
  billingCycle: "yearly",
  periodUnit: "months",
  ...overrides,
});

describe("clampRegistrationPeriod", () => {
  describe("domain items", () => {
    it("returns period unchanged when inside [min, max] (.com 5 years)", () => {
      expect(
        clampRegistrationPeriod({
          domainName: "foo.com",
          itemType: "domain",
          registrationPeriod: 5,
        })
      ).toBe(5);
    });

    it("floors below-min to TLD min (.com 0 → 1)", () => {
      expect(
        clampRegistrationPeriod({
          domainName: "foo.com",
          itemType: "domain",
          registrationPeriod: 0,
        })
      ).toBe(1);
    });

    it("caps above-max to TLD max (.com 15 → 10)", () => {
      expect(
        clampRegistrationPeriod({
          domainName: "foo.com",
          itemType: "domain",
          registrationPeriod: 15,
        })
      ).toBe(10);
    });

    it(".ai has min=2 — period 1 is floored to 2", () => {
      expect(
        clampRegistrationPeriod({
          domainName: "foo.ai",
          itemType: "domain",
          registrationPeriod: 1,
        })
      ).toBe(2);
    });

    it(".co has max=5 — period 7 is capped to 5", () => {
      expect(
        clampRegistrationPeriod({
          domainName: "foo.co",
          itemType: "domain",
          registrationPeriod: 7,
        })
      ).toBe(5);
    });

    it("missing itemType defaults to domain behaviour", () => {
      // omitting itemType — should still go through the domain branch
      expect(
        clampRegistrationPeriod({
          domainName: "foo.com",
          registrationPeriod: 15,
        })
      ).toBe(10);
    });
  });

  describe("hosting items", () => {
    it("returns period unchanged inside [1, 60]", () => {
      expect(
        clampRegistrationPeriod({
          domainName: "foo.com",
          itemType: "hosting",
          registrationPeriod: 12,
        })
      ).toBe(12);
    });

    it("floors below-1 to 1 (hosting min)", () => {
      expect(
        clampRegistrationPeriod({
          domainName: "foo.com",
          itemType: "hosting",
          registrationPeriod: 0,
        })
      ).toBe(1);
    });

    it("caps above-60 to 60 (hosting max)", () => {
      expect(
        clampRegistrationPeriod({
          domainName: "foo.com",
          itemType: "hosting",
          registrationPeriod: 100,
        })
      ).toBe(60);
    });

    it("hosting max ignores TLD policy (.co would cap domain at 5, hosting stays generous)", () => {
      // Same domain name — domain item would cap at 5, hosting caps at 60.
      // The hosting clamp must NOT consult tld-policies.
      expect(
        clampRegistrationPeriod({
          domainName: "foo.co",
          itemType: "hosting",
          registrationPeriod: 24,
        })
      ).toBe(24);
    });
  });
});

describe("validateAndCorrectCartItems", () => {
  it("empty list → empty list", () => {
    expect(validateAndCorrectCartItems([])).toEqual([]);
  });

  it("normalises missing itemType to 'domain'", () => {
    const items: CartItem[] = [
      { ...baseDomain(), itemType: undefined } as CartItem,
    ];
    const out = validateAndCorrectCartItems(items);
    expect(out).toHaveLength(1);
    expect(out[0].itemType).toBe("domain");
  });

  it("floors below-min registrationPeriod against TLD policy (.ai 1 → 2)", () => {
    const out = validateAndCorrectCartItems([
      baseDomain({ domainName: "foo.ai", registrationPeriod: 1 }),
    ]);
    expect(out[0].registrationPeriod).toBe(2);
  });

  it("does not cap above-max at list-level (registrationPeriod=15 on .com stays 15)", () => {
    // Distinct from clampRegistrationPeriod's behaviour — the list-pass
    // only floors. See cart-validation.ts:67 for the why.
    const out = validateAndCorrectCartItems([
      baseDomain({ registrationPeriod: 15 }),
    ]);
    expect(out[0].registrationPeriod).toBe(15);
  });

  it("hosting back-fix: yearly cycle + registrationPeriod=10 snaps to 12", () => {
    const out = validateAndCorrectCartItems([
      baseHosting({ registrationPeriod: 10, billingCycle: "yearly" }),
    ]);
    expect(out[0].registrationPeriod).toBe(12);
  });

  it("hosting back-fix does NOT trigger when billingCycle ≠ yearly", () => {
    const out = validateAndCorrectCartItems([
      baseHosting({ registrationPeriod: 10, billingCycle: "monthly" }),
    ]);
    expect(out[0].registrationPeriod).toBe(10);
  });

  it("hosting back-fix does NOT trigger for non-10 yearly periods", () => {
    const out = validateAndCorrectCartItems([
      baseHosting({ registrationPeriod: 24, billingCycle: "yearly" }),
    ]);
    expect(out[0].registrationPeriod).toBe(24);
  });

  it("dedups by (domainName, itemType) — later spread overrides earlier", () => {
    const out = validateAndCorrectCartItems([
      baseDomain({ domainName: "foo.com", price: 999 }),
      baseDomain({ domainName: "foo.com", price: 1499, registrationPeriod: 3 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].price).toBe(1499);
    expect(out[0].registrationPeriod).toBe(3);
  });

  it("same domain + different itemTypes are kept separate", () => {
    const out = validateAndCorrectCartItems([
      baseDomain({ domainName: "foo.com" }),
      baseHosting({ domainName: "foo.com" }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((i) => i.itemType).sort()).toEqual(["domain", "hosting"]);
  });

  it("undefined itemType and explicit 'domain' for same domain are deduped together", () => {
    // Both normalize to 'domain' — key collision should merge.
    const out = validateAndCorrectCartItems([
      { ...baseDomain(), itemType: undefined, price: 100 } as CartItem,
      baseDomain({ price: 200 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].price).toBe(200);
  });

  it("preserves all other CartItem fields through normalisation", () => {
    const out = validateAndCorrectCartItems([
      baseDomain({
        price: 1234,
        currency: "USD",
        tldAttributes: { usNexusCategory: "C11" },
      }),
    ]);
    expect(out[0].price).toBe(1234);
    expect(out[0].currency).toBe("USD");
    expect(out[0].tldAttributes).toEqual({ usNexusCategory: "C11" });
  });
});
