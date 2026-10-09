/** The portal cart's bundle trigger = ResellerOS's: a paid yearly hosting plan (9 Oct 2026). */
import { describe, it, expect } from "vitest";
import { cartHasYearlyHosting } from "@/lib/reselleros/cart-lines";

const domain = { domainName: "shop.in", price: 863, currency: "INR", registrationPeriod: 1, periodUnit: "years", itemType: "domain" as const };
const hosting = (over: Record<string, unknown> = {}) => ({ domainName: "hosting-standard", price: 125, currency: "INR", registrationPeriod: 12, itemType: "hosting" as const, billingCycle: "yearly", ...over });

describe("cartHasYearlyHosting", () => {
  it("yes for a paid yearly plan, by billing cycle or by 12 months", () => {
    expect(cartHasYearlyHosting([domain, hosting()])).toBe(true);
    expect(cartHasYearlyHosting([domain, hosting({ billingCycle: undefined, periodUnit: "months" })])).toBe(true);
  });
  it("no for a monthly plan, a trial, or no hosting", () => {
    expect(cartHasYearlyHosting([domain, hosting({ billingCycle: "monthly", registrationPeriod: 1 })])).toBe(false);
    expect(cartHasYearlyHosting([domain, hosting({ isTrial: true })])).toBe(false);
    expect(cartHasYearlyHosting([domain])).toBe(false);
  });
});
