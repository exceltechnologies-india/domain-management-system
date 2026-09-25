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
