/**
 * lib/reselleros/cart-lines.ts — DMS cart lines → ResellerOS skus
 * (owner, 25 Sep 2026: "Route through ResellerOS"). Pinned: each mapping,
 * and that every line it cannot map is refused BY NAME, never guessed.
 */
import { describe, it, expect } from "vitest";
import { mapCartToPanelOrder, type CartLineLike } from "@/lib/reselleros/cart-lines";

const hosting = (over: Partial<CartLineLike> = {}): CartLineLike => ({
  domainName: "hosting-starter-1",
  itemType: "hosting",
  registrationPeriod: 12,
  periodUnit: "months",
  billingCycle: "yearly",
  linkedDomain: "rao.in",
  hostingPlan: { id: "starter", name: "Starter Hosting" },
  ...over,
});
const domain = (name: string, over: Partial<CartLineLike> = {}): CartLineLike => ({
  domainName: name,
  itemType: "domain",
  registrationPeriod: 1,
  ...over,
});

describe("mapCartToPanelOrder", () => {
  it("hosting + domain → both skus, the hosting's domain, and an address is needed", () => {
    const m = mapCartToPanelOrder([domain("rao.in"), hosting()]);
    expect(m).toEqual({
      ok: true,
      lines: [
        { sku: "domain:in", qty: 1, domain: "rao.in" },
        { sku: "hosting:starter", qty: 1, cycle: "yearly", hostingDomain: "rao.in" },
      ],
      hostingDomain: "rao.in",
      needsAddress: true,
      summary: ["rao.in (1 year)", "Starter Hosting for rao.in (1 year)"],
    });
  });

  it("the full TLD of a second-level domain", () => {
    const m = mapCartToPanelOrder([domain("Rao.Co.In")]);
    expect(m.ok && m.lines).toEqual([{ sku: "domain:co.in", qty: 1, domain: "rao.co.in" }]);
  });

  it("monthly hosting from billingCycle, or from a 1-month period on an older line", () => {
    const a = mapCartToPanelOrder([hosting({ billingCycle: "monthly", registrationPeriod: 1 })]);
    const b = mapCartToPanelOrder([hosting({ billingCycle: undefined, registrationPeriod: 1 })]);
    expect(a.ok && a.lines[0]).toMatchObject({ cycle: "monthly" });
    expect(b.ok && b.lines[0]).toMatchObject({ cycle: "monthly" });
  });

  it("hosting only: no address needed", () => {
    const m = mapCartToPanelOrder([hosting({ hostingPlan: { id: "Plus", name: "Plus Hosting" } })]);
    expect(m).toMatchObject({ ok: true, needsAddress: false, lines: [{ sku: "hosting:plus" }] });
  });

  it.each([
    ["an unsellable plan", [hosting({ hostingPlan: { id: "25GB-wp", name: "25GB WP" } })], /"25GB WP" can't be bought online/],
    ["hosting with no domain", [hosting({ linkedDomain: undefined, domainName: "hosting-starter-1" })], /isn't linked to a domain yet/],
    ["an unknown cycle", [hosting({ billingCycle: undefined, registrationPeriod: 6 })], /monthly or yearly/],
    ["two hosting plans on one domain", [hosting(), hosting({ hostingPlan: { id: "plus", name: "Plus Hosting" } })], /"Plus Hosting" and "Starter Hosting" are both linked to rao\.in/],
    ["a domain set to more than 10 years", [domain("rao.in", { registrationPeriod: 11 })], /rao\.in is set to 11 years, and a domain is registered for whole years, 1 to 10/],
    ["a domain set to a part year", [domain("rao.in", { registrationPeriod: 18, periodUnit: "months" })], /rao\.in is set to 18 months/],
    ["a restricted TLD needing registry details", [domain("rao.us", { tldAttributes: { nexus: "C11" } })], /rao\.us needs extra registry details/],
    ["an unknown item type", [{ domainName: "ssl-cert", itemType: "ssl" }], /"ssl-cert" is not something online checkout can sell/],
    ["a trial with paid items", [hosting({ isTrial: true }), domain("rao.in")], /free trial together with paid items/],
  ])("refuses %s, naming it, and says nothing was charged", (_label, items, pattern) => {
    const m = mapCartToPanelOrder(items as CartLineLike[]);
    expect(m.ok).toBe(false);
    if (m.ok) return;
    expect(m.message).toMatch(pattern);
    if (!/free trial/.test(m.message)) expect(m.message).toMatch(/Nothing was charged/);
  });

  /* 5 Oct 2026: ResellerOS takes several hosting plans in one order, each on its own domain
     (its R-032), so the DMS cart no longer refuses a second plan. */
  it("two hosting plans on two domains → two hosting lines, each with its own domain", () => {
    const m = mapCartToPanelOrder([
      hosting(),
      hosting({ linkedDomain: "shop.in", hostingPlan: { id: "plus", name: "Plus Hosting" }, billingCycle: "monthly", registrationPeriod: 1 }),
    ]);
    expect(m).toMatchObject({
      ok: true,
      hostingDomain: "rao.in",
      lines: [
        { sku: "hosting:starter", cycle: "yearly", hostingDomain: "rao.in" },
        { sku: "hosting:plus", cycle: "monthly", hostingDomain: "shop.in" },
      ],
      summary: ["Starter Hosting for rao.in (1 year)", "Plus Hosting for shop.in (1 month)"],
    });
  });

  /* 9 Oct 2026: ResellerOS sells 2, 3 and 5-year terms (its R-156) and prices them itself, so
     the panel cart passes the chosen years on instead of refusing them. */
  it("a multi-year domain goes to ResellerOS with its years", () => {
    const m = mapCartToPanelOrder([domain("rao.in", { registrationPeriod: 3 })]);
    expect(m).toMatchObject({ ok: true, lines: [{ sku: "domain:in", qty: 1, domain: "rao.in", years: 3 }], summary: ["rao.in (3 years)"] });
  });
  it("a term kept in months becomes years, and 1 year carries no years field", () => {
    const m = mapCartToPanelOrder([domain("rao.in", { registrationPeriod: 24, periodUnit: "months" })]);
    expect(m.ok && m.lines[0]).toEqual({ sku: "domain:in", qty: 1, domain: "rao.in", years: 2 });
    const one = mapCartToPanelOrder([domain("rao.in")]);
    expect(one.ok && one.lines[0]).toEqual({ sku: "domain:in", qty: 1, domain: "rao.in" });
  });

  it("an empty cart is refused", () => {
    expect(mapCartToPanelOrder([]).ok).toBe(false);
  });
});
