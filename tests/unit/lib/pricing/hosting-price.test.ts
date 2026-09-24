/**
 * What DMS charges for hosting: ResellerOS's price plus 18% GST.
 *
 * Owner decision, 24 Sep 2026: "ResellerOS is correct price one. Use that."
 * Before it, DMS read the same per-month figure as GST-INCLUSIVE, so a Starter
 * year cost ₹599.88 here and ₹708 on ResellerOS.
 *
 * The expected figures below are ResellerOS's own formula, written out by hand
 * from `api/public/checkout/cart` (rate = round(yearlyTotal | monthly),
 * amount = round(rate × 1.18)), so a change to either side fails here.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  cartLinePrice,
  cycleFromMonths,
  hostingCharge,
  lineTotal,
  perMonthRate,
  upgradeCharge,
} from "@/lib/pricing/hosting-price";
import { repriceHostingItems } from "@/lib/pricing/reprice-hosting";
import { dmsCreatesHostingSubscriptions } from "@/lib/pricing/hosting-billing-mode";
import type { CartItem } from "@/lib/types";

describe("hostingCharge — ResellerOS's figures, exactly", () => {
  it.each([
    ["starter", "yearly", 600, 708],
    ["starter", "monthly", 100, 118],
    ["standard", "yearly", 1500, 1770],
    ["standard", "monthly", 250, 295],
    ["plus", "yearly", 2246, 2650],
    ["plus", "monthly", 374, 441],
  ] as const)("%s %s: ₹%i + GST = ₹%i", (plan, cycle, exGst, inclGst) => {
    const c = hostingCharge(plan, cycle);
    expect(c).not.toBeNull();
    expect(c?.exGst).toBe(exGst);
    expect(c?.inclGst).toBe(inclGst);
    expect(c?.gst).toBe(inclGst - exGst);
    expect(c?.months).toBe(cycle === "yearly" ? 12 : 1);
  });

  it("matches Mongo's capitalised plan ids", () => {
    expect(hostingCharge("Starter", "yearly")?.inclGst).toBe(708);
  });

  it("returns null — never a guess — for a plan ResellerOS does not sell", () => {
    for (const id of ["25GB-wp", "ultimatepackage", "", null, undefined, "constructor", "toString"]) {
      expect(hostingCharge(id, "yearly")).toBeNull();
    }
  });
});

describe("cart-line arithmetic", () => {
  it("price × months gives back the charge, to the paisa, for every plan and cycle", () => {
    for (const plan of ["starter", "standard", "plus"]) {
      for (const cycle of ["yearly", "monthly"] as const) {
        const c = hostingCharge(plan, cycle);
        if (!c) throw new Error(`unpriced ${plan}`);
        expect(lineTotal(cartLinePrice(c), c.months)).toBe(c.inclGst);
      }
    }
  });

  it("12 months is yearly, anything else monthly", () => {
    expect(cycleFromMonths(12)).toBe("yearly");
    expect(cycleFromMonths(1)).toBe("monthly");
    expect(cycleFromMonths(undefined)).toBe("monthly");
  });
});

describe("upgradeCharge", () => {
  it("prorates the difference in ResellerOS monthly rates, floor ₹100", () => {
    expect(perMonthRate("starter")).toBe(59);
    expect(upgradeCharge("starter", "plus", 60)).toEqual({ ok: true, amount: 324 });
    expect(upgradeCharge("starter", "standard", 3)).toEqual({ ok: true, amount: 100 });
  });

  it("refuses sideways, downwards and unpriced moves", () => {
    expect(upgradeCharge("plus", "starter", 30)).toEqual({ ok: false, reason: "not-higher" });
    expect(upgradeCharge("starter", "Starter", 30)).toEqual({ ok: false, reason: "not-higher" });
    expect(upgradeCharge("starter", "25GB-wp", 30)).toEqual({ ok: false, reason: "unpriced" });
  });
});

describe("repriceHostingItems", () => {
  const line = (price: number, months: number, id = "starter"): CartItem => ({
    domainName: "hosting-x",
    price,
    currency: "INR",
    registrationPeriod: months,
    itemType: "hosting",
    hostingPlan: { id, name: id, period: months, features: [] },
  });

  it("accepts the right figure and normalises the line", () => {
    const items = [line(59, 12)];
    expect(repriceHostingItems(items)).toEqual({ ok: true });
    expect(items[0].price * (items[0].registrationPeriod ?? 0)).toBe(708);
  });

  it("refuses the OLD DMS figure with the new one, saying nothing was charged", () => {
    const r = repriceHostingItems([line(49.99, 12)]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("PRICE_CHANGED");
    expect(r.body.serverTotal).toBe(708);
    expect(r.body.error).toMatch(/Nothing was charged/);
    expect(r.body.error).toMatch(/add it again/);
  });

  it("refuses an unpriced plan with where to go instead", () => {
    const r = repriceHostingItems([line(1, 12, "25GB-wp")]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.body.code).toBe("HOSTING_PLAN_UNPRICED");
    expect(r.body.error).toMatch(/Buy hosting/);
  });

  it("forces a trial's today-charge to ₹0 whatever the browser sent", () => {
    const items = [{ ...line(500, 15), isTrial: true }];
    expect(repriceHostingItems(items).ok).toBe(true);
    expect(items[0].price).toBe(0);
  });

  it("leaves domain lines to the domain price verifier", () => {
    const items: CartItem[] = [{ domainName: "a.in", price: 1, currency: "INR", registrationPeriod: 1 }];
    expect(repriceHostingItems(items)).toEqual({ ok: true });
    expect(items[0].price).toBe(1);
  });
});

describe("DMS hosting subscriptions are OFF unless exactly '1'", () => {
  const ORIGINAL = process.env.DMS_HOSTING_SUBSCRIPTIONS_ENABLED;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DMS_HOSTING_SUBSCRIPTIONS_ENABLED;
    else process.env.DMS_HOSTING_SUBSCRIPTIONS_ENABLED = ORIGINAL;
  });

  it("fails closed", () => {
    delete process.env.DMS_HOSTING_SUBSCRIPTIONS_ENABLED;
    expect(dmsCreatesHostingSubscriptions()).toBe(false);
    for (const v of ["", "0", "true", "yes", " 1"]) {
      process.env.DMS_HOSTING_SUBSCRIPTIONS_ENABLED = v;
      expect(dmsCreatesHostingSubscriptions(), JSON.stringify(v)).toBe(false);
    }
    process.env.DMS_HOSTING_SUBSCRIPTIONS_ENABLED = "1";
    expect(dmsCreatesHostingSubscriptions()).toBe(true);
  });
});
