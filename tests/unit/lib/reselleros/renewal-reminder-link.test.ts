/**
 * lib/reselleros/renewal-reminder-link.ts — what a DMS renewal reminder may
 * link to (owner, 26 Sep 2026: "Point to the ResellerOS quote"). One test per
 * branch; none of them carries an amount.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchCustomerBills = vi.hoisted(() => vi.fn());
vi.mock("@/lib/reselleros/bills", () => ({ fetchCustomerBills }));

import { resolveRenewalReminderLink } from "@/lib/reselleros/renewal-reminder-link";

const quote = (id: string, status: string, paymentUrl: string | null = `https://ros.test/quote/${id}/accept`) => ({
  id,
  amount: 708,
  currency: "INR",
  status,
  pdfUrl: null,
  paymentUrl,
});

// Braces matter: an arrow that RETURNS the mock would be run by vitest as a
// teardown hook — calling the (throwing) mock after the test.
beforeEach(() => {
  fetchCustomerBills.mockReset();
});

describe("resolveRenewalReminderLink", () => {
  it("one pending quote → pay, straight to its payment_url", async () => {
    fetchCustomerBills.mockResolvedValue({ kind: "ok", customerId: "C-1", quotes: [quote("Q-1", "accepted"), quote("Q-2", "pending")], invoices: [] });
    expect(await resolveRenewalReminderLink("a@x.test")).toEqual({ kind: "pay", paymentUrl: "https://ros.test/quote/Q-2/accept" });
    expect(fetchCustomerBills).toHaveBeenCalledWith("a@x.test", {});
  });

  it("several pending quotes → choose, linking the panel's Invoices page (never a guessed quote)", async () => {
    fetchCustomerBills.mockResolvedValue({ kind: "ok", customerId: "C-1", quotes: [quote("Q-1", "pending"), quote("Q-2", "pending")], invoices: [] });
    expect(await resolveRenewalReminderLink("a@x.test", { panelBaseUrl: "https://dms.test/" })).toEqual({
      kind: "choose",
      count: 2,
      invoicesUrl: "https://dms.test/dashboard/invoices",
    });
  });

  it("several pending but no absolute panel URL → unknown (a relative link in an email is dead)", async () => {
    fetchCustomerBills.mockResolvedValue({ kind: "ok", customerId: "C-1", quotes: [quote("Q-1", "pending"), quote("Q-2", "pending")], invoices: [] });
    expect(await resolveRenewalReminderLink("a@x.test", { panelBaseUrl: "" })).toEqual({ kind: "unknown" });
  });

  it("no pending quote with a Pay link → preparing", async () => {
    fetchCustomerBills.mockResolvedValue({ kind: "ok", customerId: "C-1", quotes: [quote("Q-1", "accepted"), quote("Q-3", "pending", null)], invoices: [] });
    expect(await resolveRenewalReminderLink("a@x.test")).toEqual({ kind: "preparing" });
  });

  it("no customer at ResellerOS → preparing", async () => {
    fetchCustomerBills.mockResolvedValue({ kind: "no_bills" });
    expect(await resolveRenewalReminderLink("a@x.test")).toEqual({ kind: "preparing" });
  });

  it.each([
    { kind: "unavailable", detail: "HTTP 500" },
    { kind: "not_configured", missing: ["RESELLEROS_BILLING_API_KEY"] },
    { kind: "not_confirmed", detail: "email mismatch" },
  ])("$kind → unknown (the reminder still goes, with no link)", async (outcome) => {
    fetchCustomerBills.mockResolvedValue(outcome);
    expect(await resolveRenewalReminderLink("a@x.test")).toEqual({ kind: "unknown" });
  });

  it("a throw → unknown, never an error that stops the reminder", async () => {
    fetchCustomerBills.mockImplementation(async () => {
      throw new Error("boom");
    });
    const result = await resolveRenewalReminderLink("a@x.test");
    expect(result).toEqual({ kind: "unknown" });
  });
});
