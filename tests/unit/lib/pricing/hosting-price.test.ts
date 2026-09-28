/**
 * What DMS charges for hosting: ResellerOS's price plus 18% GST.
 *
 * Owner decision, 24 Sep 2026: "ResellerOS is correct price one. Use that."
 * Before it, DMS read the same per-month figure as GST-INCLUSIVE, so a Starter
 * year cost ₹599.88 here and ₹708 on ResellerOS.
 *
 * Since 28 Sep 2026 DMS reads the prices LIVE from ResellerOS
 * (`/api/public/hosting-prices`) and keeps no copy, so these functions take the
 * table as an argument. The expected figures are ResellerOS's own formula,
 * written out by hand; PRICE_TABLE is that endpoint's answer on 28 Sep 2026.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  cartLinePrice,
  cycleFromMonths,
  hostingCharge,
  lineTotal,
  perMonthRate,
  parseHostingPriceTable,
  upgradeCharge,
} from "@/lib/pricing/hosting-price";
import { PRICE_TABLE } from "../../../fixtures/hosting-price-table";
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
    const c = hostingCharge(PRICE_TABLE, plan, cycle);
    expect(c).not.toBeNull();
    expect(c?.exGst).toBe(exGst);
    expect(c?.inclGst).toBe(inclGst);
    expect(c?.gst).toBe(inclGst - exGst);
    expect(c?.months).toBe(cycle === "yearly" ? 12 : 1);
  });

  it("matches Mongo's capitalised plan ids", () => {
    expect(hostingCharge(PRICE_TABLE, "Starter", "yearly")?.inclGst).toBe(708);
  });

  it("returns null — never a guess — for a plan ResellerOS does not sell", () => {
    for (const id of ["25GB-wp", "ultimatepackage", "", null, undefined, "constructor", "toString"]) {
      expect(hostingCharge(PRICE_TABLE, id, "yearly")).toBeNull();
    }
  });
});

describe("cart-line arithmetic", () => {
  it("price × months gives back the charge, to the paisa, for every plan and cycle", () => {
    for (const plan of ["starter", "standard", "plus"]) {
      for (const cycle of ["yearly", "monthly"] as const) {
        const c = hostingCharge(PRICE_TABLE, plan, cycle);
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
    expect(perMonthRate(PRICE_TABLE, "starter")).toBe(59);
    expect(upgradeCharge(PRICE_TABLE, "starter", "plus", 60)).toEqual({ ok: true, amount: 324 });
    expect(upgradeCharge(PRICE_TABLE, "starter", "standard", 3)).toEqual({ ok: true, amount: 100 });
  });

  it("refuses sideways, downwards and unpriced moves", () => {
    expect(upgradeCharge(PRICE_TABLE, "plus", "starter", 30)).toEqual({ ok: false, reason: "not-higher" });
    expect(upgradeCharge(PRICE_TABLE, "starter", "Starter", 30)).toEqual({ ok: false, reason: "not-higher" });
    expect(upgradeCharge(PRICE_TABLE, "starter", "25GB-wp", 30)).toEqual({ ok: false, reason: "unpriced" });
  });
});

describe("parseHostingPriceTable — a half-read table is not a price", () => {
  it("accepts ResellerOS's answer as it is", () => {
    expect(parseHostingPriceTable(JSON.parse(JSON.stringify(PRICE_TABLE)))).toEqual(PRICE_TABLE);
  });
  it("refuses a missing, zero or non-numeric figure, and an empty plan list", () => {
    const bad = (mut: (t: typeof PRICE_TABLE) => void) => {
      const t = JSON.parse(JSON.stringify(PRICE_TABLE));
      mut(t);
      return parseHostingPriceTable(t);
    };
    expect(bad((t) => { t.plans[0].yearly.inclGst = 0; })).toBeNull();
    expect(bad((t) => { (t.plans[1].monthly as unknown as { exGst: string }).exGst = "250"; })).toBeNull();
    expect(bad((t) => { delete (t.plans[2] as Partial<typeof t.plans[2]>).perMonthYearly; })).toBeNull();
    expect(bad((t) => { t.plans = []; })).toBeNull();
    expect(parseHostingPriceTable(null)).toBeNull();
  });
});
