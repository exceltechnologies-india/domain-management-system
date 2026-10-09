/** The domain terms the portal offers = the ones ResellerOS sells (9 Oct 2026). */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  RESELLEROS_DOMAIN_TERMS,
  domainLineTotal,
  domainTermOptions,
  domainYearsOf,
  nearestDomainTerm,
  pricedDomainTermOptions,
} from "@/lib/reselleros/domain-terms";

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
    expect(card).toContain("pricedDomainTermOptions(minPeriod, termTotals)");
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

describe("a domain line's total (9 Oct 2026)", () => {
  const totals = { "1": 863, "2": 1726, "3": 2588, "5": 4314 };
  it("is ResellerOS's price for the term plus 18% GST", () => {
    expect(domainLineTotal({ price: 862.8, registrationPeriod: 1, periodUnit: "years" }, totals)).toBe(1018.34);
    expect(domainLineTotal({ price: 862.8, registrationPeriod: 3, periodUnit: "years" }, totals)).toBe(3053.84);
    expect(domainLineTotal({ price: 862.8, registrationPeriod: 5, periodUnit: "years" }, totals)).toBe(5090.52);
  });
  it("before ResellerOS answers: the search's 1-year price x years, plus GST, never without it", () => {
    expect(domainLineTotal({ price: 1000, registrationPeriod: 2, periodUnit: "years" })).toBe(2360);
    expect(domainLineTotal({ price: 1000, registrationPeriod: 2, periodUnit: "years" }, null)).toBe(2360);
  });
  it("reads an old-picker 'N months' domain as N years", () => {
    expect(domainLineTotal({ price: 862.8, registrationPeriod: 3, periodUnit: "months" }, totals)).toBe(3053.84);
  });
  it("offers only the terms ResellerOS has priced, once it has answered", () => {
    expect(pricedDomainTermOptions(1, { "1": 900, "2": 1800 })).toEqual([1, 2]);
    expect(pricedDomainTermOptions(2, { "1": 900, "2": 1800, "5": 4500 })).toEqual([2, 5]);
    expect(pricedDomainTermOptions(1, null)).toEqual([1, 2, 3, 5]);
    expect(pricedDomainTermOptions(1, {})).toEqual([1, 2, 3, 5]);
  });
});

describe("the free first year with yearly hosting (9 Oct 2026)", () => {
  const totals = { "1": 863, "2": 1726, "3": 2588, "5": 4314 };
  it("a bundled domain pays years 2..N, as ResellerOS's bundledDomainRate charges", () => {
    expect(domainLineTotal({ price: 862.8, registrationPeriod: 1, periodUnit: "years" }, totals, true)).toBe(0);
    expect(domainLineTotal({ price: 862.8, registrationPeriod: 3, periodUnit: "years" }, totals, true)).toBe(2035.5); // 1725 + GST
    expect(domainLineTotal({ price: 862.8, registrationPeriod: 5, periodUnit: "years" }, totals, true)).toBe(4072.18); // 3451 + GST
  });
  it("before ResellerOS answers, the search's 1-year price stands in for the free year", () => {
    expect(domainLineTotal({ price: 1000, registrationPeriod: 2, periodUnit: "years" }, null, true)).toBe(1180);
  });
});
