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
        { sku: "hosting:starter", qty: 1, cycle: "yearly" },
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
    ["two hosting plans", [hosting(), hosting({ hostingPlan: { id: "plus", name: "Plus Hosting" } })], /more than one hosting plan.*"Plus Hosting"/],
    ["a multi-year domain", [domain("rao.in", { registrationPeriod: 3 })], /rao\.in is set to 3 years/],
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

  it("an empty cart is refused", () => {
    expect(mapCartToPanelOrder([]).ok).toBe(false);
  });
});
