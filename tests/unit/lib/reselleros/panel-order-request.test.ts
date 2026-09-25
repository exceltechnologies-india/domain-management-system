/**
 * lib/reselleros/panel-order-request.ts — the ResellerOS body for a panel
 * purchase. Identity comes from the session's User; the body only chooses.
 */
import { describe, it, expect } from "vitest";
import { buildPanelOrderRequest, panelPurchaseSchema, type PanelBuyer } from "@/lib/reselleros/panel-order-request";

const BUYER: PanelBuyer = { id: "65f0c0ffee0000000000abcd", email: "asha@example.test", firstName: "Asha", lastName: "Rao", phone: "98765 43210" };
const ADDRESS = { line1: "1 MG Road", city: "Delhi", state: "Delhi", zipcode: "110001" };

describe("buildPanelOrderRequest", () => {
  it("hosting: one line with the plan and cycle, and the domain it is set up on", () => {
    const r = buildPanelOrderRequest(BUYER, {
      purchase: { kind: "hosting", planId: "standard", cycle: "monthly", domain: "Rao.IN" },
      companyName: "Rao Traders",
    });
    expect(r).toEqual({
      ok: true,
      request: {
        dmsUserId: BUYER.id,
        fullName: "Asha Rao",
        companyName: "Rao Traders",
        email: "asha@example.test",
        phone: "9876543210",
        domain: "rao.in",
        lines: [{ sku: "hosting:standard", qty: 1, cycle: "monthly" }],
      },
    });
  });

  it("domain: sku from the full TLD, qty 1, the exact name, and the address (country IN)", () => {
    const r = buildPanelOrderRequest(BUYER, {
      purchase: { kind: "domain", domain: "rao.co.in" },
      companyName: "Rao Traders",
      gstin: "07aabcr1234a1z5",
      address: ADDRESS,
    });
    expect(r.ok && r.request.lines).toEqual([{ sku: "domain:co.in", qty: 1, domain: "rao.co.in" }]);
    expect(r.ok && r.request.address).toEqual({ ...ADDRESS, country: "IN" });
    expect(r.ok && r.request.gstin).toBe("07AABCR1234A1Z5");
    expect(r.ok && "domain" in r.request).toBe(false);
  });

  it("identity is the buyer's even if the body tries to carry its own", () => {
    const body = panelPurchaseSchema.parse({
      purchase: { kind: "hosting", planId: "starter", cycle: "yearly", domain: "rao.in" },
      companyName: "Rao Traders",
      email: "attacker@example.test",
      dmsUserId: "someone-else",
      fullName: "Mallory",
    });
    const r = buildPanelOrderRequest(BUYER, body);
    expect(r.ok && r.request.email).toBe("asha@example.test");
    expect(r.ok && r.request.dmsUserId).toBe(BUYER.id);
    expect(r.ok && r.request.fullName).toBe("Asha Rao");
  });

  it("a domain with no address is refused before ResellerOS is asked", () => {
    const r = buildPanelOrderRequest(BUYER, { purchase: { kind: "domain", domain: "rao.in" }, companyName: "Rao Traders" });
    expect(r).toMatchObject({ ok: false, field: "address" });
  });

  it("no phone on the account: refused, pointing at Settings", () => {
    const r = buildPanelOrderRequest({ ...BUYER, phone: undefined }, {
      purchase: { kind: "hosting", planId: "starter", cycle: "yearly", domain: "rao.in" },
      companyName: "Rao Traders",
    });
    expect(r).toMatchObject({ ok: false, field: "phone" });
    expect(!r.ok && r.message).toMatch(/Settings/);
  });

  it("no name on the account: refused, never invented", () => {
    const r = buildPanelOrderRequest({ ...BUYER, firstName: "", lastName: "" }, {
      purchase: { kind: "hosting", planId: "starter", cycle: "yearly", domain: "rao.in" },
      companyName: "Rao Traders",
    });
    expect(r).toMatchObject({ ok: false, field: "name" });
  });

  it("a hosting domain that is not a domain is refused", () => {
    const r = buildPanelOrderRequest(BUYER, {
      purchase: { kind: "hosting", planId: "starter", cycle: "yearly", domain: "hosting-starter-1700" },
      companyName: "Rao Traders",
    });
    expect(r).toMatchObject({ ok: false, field: "domain" });
  });

  it("the schema offers only the three plans ResellerOS sells", () => {
    expect(
      panelPurchaseSchema.safeParse({ purchase: { kind: "hosting", planId: "enterprise", cycle: "yearly", domain: "rao.in" }, companyName: "Rao" }).success,
    ).toBe(false);
  });
});

describe("buildPanelOrderRequest — the DMS cart (owner, 25 Sep 2026)", () => {
  it("maps the cart, takes identity from the buyer, and requires the address for a domain line", () => {
    const body = panelPurchaseSchema.parse({
      purchase: {
        kind: "cart",
        items: [
          { domainName: "rao.in", itemType: "domain", registrationPeriod: 1, price: 1 },
          { domainName: "hosting-starter-1", itemType: "hosting", registrationPeriod: 12, billingCycle: "yearly", linkedDomain: "rao.in", hostingPlan: { id: "starter", name: "Starter" }, price: 99999 },
        ],
      },
      companyName: "Rao Traders",
      address: ADDRESS,
    });
    const r = buildPanelOrderRequest(BUYER, body);
    expect(r).toMatchObject({
      ok: true,
      request: {
        dmsUserId: BUYER.id,
        email: "asha@example.test",
        domain: "rao.in",
        lines: [
          { sku: "domain:in", qty: 1, domain: "rao.in" },
          { sku: "hosting:starter", qty: 1, cycle: "yearly" },
        ],
      },
    });
    // Prices from the browser never travel.
    expect(JSON.stringify(r)).not.toMatch(/99999|"price"/);
  });

  it("a domain in the cart with no address is refused", () => {
    const r = buildPanelOrderRequest(BUYER, {
      purchase: { kind: "cart", items: [{ domainName: "rao.in", itemType: "domain", registrationPeriod: 1 }] },
      companyName: "Rao Traders",
    });
    expect(r).toMatchObject({ ok: false, field: "address" });
  });

  it("an unmappable line is refused with the mapper's message", () => {
    const r = buildPanelOrderRequest(BUYER, {
      purchase: { kind: "cart", items: [{ domainName: "rao.in", itemType: "domain", registrationPeriod: 2 }] },
      companyName: "Rao Traders",
      address: ADDRESS,
    });
    expect(r).toMatchObject({ ok: false, field: "cart" });
    expect(!r.ok && r.message).toMatch(/rao\.in is set to 2 years/);
  });
});
