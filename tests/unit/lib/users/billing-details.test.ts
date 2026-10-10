/** lib/users/billing-details — a paying customer's details, reused across purchases (10 Oct 2026). */
import { describe, it, expect } from "vitest";
import { billingDetailsOf, mergeBillingDetails, parseBillingDetails } from "@/lib/users/billing-details";
import { checkoutNeeds, PANEL_PRODUCTS } from "@/lib/purchase/catalog";

describe("parseBillingDetails", () => {
  it("keeps well-formed details and normalises them", () => {
    expect(parseBillingDetails({ companyName: " Asha Co ", gstin: "07abdca0298h1zp", state: "delhi", address: { line1: "12 MG Road", city: "New Delhi", zipcode: "110001" } }))
      .toEqual({ companyName: "Asha Co", gstin: "07ABDCA0298H1ZP", state: "Delhi", address: { line1: "12 MG Road", city: "New Delhi", zipcode: "110001", country: "IN" } });
  });
  it("drops anything malformed rather than guessing", () => {
    expect(parseBillingDetails({ gstin: "123", address: { line1: "12 MG Road", city: "", zipcode: "1" }, companyName: "A" })).toEqual({});
    expect(parseBillingDetails(null)).toEqual({});
  });
  it("takes the state from the address when it is only there", () => {
    expect(parseBillingDetails({ address: { line1: "1 Road", city: "Pune", state: "Maharashtra", zipcode: "411001" } }).state).toBe("Maharashtra");
  });
});

describe("mergeBillingDetails", () => {
  const d = parseBillingDetails({ companyName: "New Co", gstin: "07ABDCA0298H1ZP", state: "Delhi", address: { line1: "12 MG Road", city: "New Delhi", zipcode: "110001" } });
  it("an order only FILLS empty fields — never overwrites what the customer set", () => {
    const user = { companyName: "My Own Co", address: { state: "Karnataka" } };
    const changed = mergeBillingDetails(user, d, "fill");
    expect(changed.sort()).toEqual(["address", "gstin"]);
    expect(user).toMatchObject({ companyName: "My Own Co", gstNumber: "07ABDCA0298H1ZP", address: { state: "Karnataka", line1: "12 MG Road", city: "New Delhi", zipcode: "110001" } });
  });
  it("the customer's own 'Save for next time' REPLACES them", () => {
    const user = { companyName: "Old Co", gstNumber: "29AAAAA0000A1Z5", address: { line1: "Old", city: "Old", zipcode: "000", state: "Karnataka" } };
    mergeBillingDetails(user, d, "replace");
    expect(user).toMatchObject({ companyName: "New Co", gstNumber: "07ABDCA0298H1ZP", address: { line1: "12 MG Road", state: "Delhi" } });
  });
  it("nothing to change reports nothing, so nothing is saved", () => {
    const user = { companyName: "New Co" };
    expect(mergeBillingDetails(user, { companyName: "New Co" }, "replace")).toEqual([]);
  });
});

describe("billingDetailsOf", () => {
  it("says whether checkout can skip the form: state for hosting, state + address for a domain", () => {
    expect(billingDetailsOf({ address: { state: "Delhi" } }).complete).toEqual({ forHosting: true, forDomain: false });
    expect(billingDetailsOf({ address: { state: "Delhi", line1: "1 Road", city: "Delhi", zipcode: "110001" } }).complete).toEqual({ forHosting: true, forDomain: true });
    expect(billingDetailsOf({}).complete).toEqual({ forHosting: false, forDomain: false });
  });
});

describe("the purchase catalogue", () => {
  it("declares what each product needs; hosting that registers its domain also needs the address", () => {
    expect(checkoutNeeds("hosting").registrantAddress).toBe(false);
    expect(checkoutNeeds("hosting", { registerDomain: true }).registrantAddress).toBe(true);
    expect(checkoutNeeds("domain").registrantAddress).toBe(true);
  });
  it("already lists the planned products (business email, SSL) so the design fits them", () => {
    expect(PANEL_PRODUCTS.email).toMatchObject({ available: false, needs: { siteDomain: true, term: "seats" } });
    expect(PANEL_PRODUCTS.ssl).toMatchObject({ available: false, needs: { siteDomain: true } });
  });
});
