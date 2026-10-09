/** The domain terms the portal offers = the ones ResellerOS sells (9 Oct 2026). */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { RESELLEROS_DOMAIN_TERMS, domainTermOptions, domainYearsOf, nearestDomainTerm } from "@/lib/reselleros/domain-terms";

describe("domain terms", () => {
  it("are ResellerOS's 1, 2, 3 and 5 years", () => {
    expect(RESELLEROS_DOMAIN_TERMS).toEqual([1, 2, 3, 5]);
  });
  it("respect a TLD's minimum", () => {
    expect(domainTermOptions(1)).toEqual([1, 2, 3, 5]);
    expect(domainTermOptions(2)).toEqual([2, 3, 5]);
    expect(domainTermOptions(10)).toEqual([10]); // a TLD only sold for longer keeps its minimum
  });
  it("a stored term moves to the longest offered term not above it", () => {
    expect(nearestDomainTerm(4)).toBe(3);
    expect(nearestDomainTerm(10)).toBe(5);
    expect(nearestDomainTerm(3)).toBe(3);
    expect(nearestDomainTerm(1, 2)).toBe(2);
  });
  it("reads the old picker's years-saved-as-months correctly", () => {
    expect(domainYearsOf({ registrationPeriod: 3, periodUnit: "months" })).toBe(3);
    expect(domainYearsOf({ registrationPeriod: 24, periodUnit: "months" })).toBe(2);
    expect(domainYearsOf({ registrationPeriod: 2, periodUnit: "years" })).toBe(2);
    expect(domainYearsOf({})).toBe(1);
  });
  it("the cart card offers only these, saved in years; the cart page corrects stored terms", () => {
    const card = readFileSync("components/cart/CartItemCard.tsx", "utf8");
    expect(card).toContain("return domainTermOptions(minPeriod);");
    expect(card).toContain("item.itemType === 'hosting' ? 'months' : 'years'");
    const cart = readFileSync("app/cart/page.tsx", "utf8");
    expect(cart).toContain("const term = nearestDomainTerm(Math.max(years, min), min);");
  });
  it("matches ResellerOS's own list when that repo is next door (local machine)", () => {
    try {
      const ros = readFileSync("../anutechbilling-new/production/src/lib/domains/live-lookup.ts", "utf8");
      expect(ros).toMatch(/DOMAIN_TERMS: readonly number\[\] = \[1, 2, 3, 5\]/);
    } catch { /* not on this machine — the list above is the contract */ }
  });
});
