/**
 * lib/reselleros/renewal-choice.ts — what a Renew button offers now that
 * renewals are ResellerOS's. Pinned: only PENDING quotes with a Pay link are
 * offered; none → "none", never a guessed amount; unreadable → unavailable.
 */
import { describe, it, expect } from "vitest";
import { noRenewalQuoteMessage, renewalChoice } from "@/lib/reselleros/renewal-choice";

describe("renewalChoice", () => {
  it("offers every pending quote that has a Pay link, and nothing else", () => {
    const choice = renewalChoice({
      state: "ok",
      quotes: [
        { id: "Q-1", amount: 708, status: "accepted", paymentUrl: "https://ros.test/q1" },
        { id: "Q-2", amount: 708, status: "pending", paymentUrl: "https://ros.test/q2" },
        { id: "Q-3", amount: 295, status: "pending", paymentUrl: null },
        { id: "Q-4", amount: 1770, status: "expired", paymentUrl: "https://ros.test/q4" },
      ],
    });
    expect(choice).toEqual({ kind: "pay", quotes: [{ id: "Q-2", amount: 708, paymentUrl: "https://ros.test/q2" }] });
  });

  it("no pending quote → none", () => {
    expect(renewalChoice({ state: "ok", quotes: [{ id: "Q-1", amount: 1, status: "accepted", paymentUrl: "x" }] })).toEqual({
      kind: "none",
    });
  });

  it("no customer at ResellerOS → none", () => {
    expect(renewalChoice({ state: "no_bills" })).toEqual({ kind: "none" });
  });

  describe("matched to the service being renewed (28 Sep 2026)", () => {
    const hostingBill = { id: "Q-H", amount: 708, status: "pending", paymentUrl: "https://ros.test/qh", renews: [{ vendor: "hosting", domain: "Acme.in" }] };
    const domainBill = { id: "Q-D", amount: 899, status: "pending", paymentUrl: "https://ros.test/qd", renews: [{ vendor: "domain", domain: "acme.in" }] };
    const newOrder = { id: "Q-N", amount: 708, status: "pending", paymentUrl: "https://ros.test/qn", renews: [] };
    const unknown = { id: "Q-U", amount: 500, status: "pending", paymentUrl: "https://ros.test/qu" };
    const ids = (c: ReturnType<typeof renewalChoice>) => (c.kind === "pay" ? c.quotes.map((q) => q.id) : c.kind);

    it("the domain's Renew offers only the domain's bill — not the hosting renewal, not a new order", () => {
      expect(ids(renewalChoice({ state: "ok", quotes: [hostingBill, domainBill, newOrder] }, { type: "domain", name: "acme.in" }))).toEqual(["Q-D"]);
    });
    it("the hosting account's Renew offers only its bill (domain matched ignoring case)", () => {
      expect(ids(renewalChoice({ state: "ok", quotes: [hostingBill, domainBill, newOrder] }, { type: "hosting", name: "acme.in" }))).toEqual(["Q-H"]);
    });
    it("a bill for another domain of the same kind is not offered; none left → none", () => {
      expect(ids(renewalChoice({ state: "ok", quotes: [hostingBill] }, { type: "hosting", name: "other.in" }))).toBe("none");
    });
    it("a quote whose `renews` ResellerOS did not send is still offered, never hidden", () => {
      expect(ids(renewalChoice({ state: "ok", quotes: [unknown, newOrder] }, { type: "domain", name: "acme.in" }))).toEqual(["Q-U"]);
    });
    it("without a service, behaves as before (every pending bill)", () => {
      expect(ids(renewalChoice({ state: "ok", quotes: [hostingBill, domainBill, newOrder] }))).toEqual(["Q-H", "Q-D", "Q-N"]);
    });
  });

  it("unreadable → unavailable, carrying the message (never 'none')", () => {
    expect(renewalChoice({ state: "unavailable", message: "down" })).toEqual({ kind: "unavailable", message: "down" });
  });
});

describe("noRenewalQuoteMessage", () => {
  it("says what, why and what next", () => {
    const m = noRenewalQuoteMessage("example.in", "help@example.test");
    expect(m).toMatch(/no renewal bill for example\.in/);
    expect(m).toMatch(/emails you a renewal bill/);
    expect(m).toMatch(/help@example\.test/);
  });
});
