/**
 * Tests for `@/lib/zohobooks/recurring` (rescan-4 slice 7ea).
 * createRecurringInvoice — per-hosting-item RIP creation flow. Pins:
 *  - no refresh-token → returns [] (lazy-init safe)
 *  - get-or-create contact: getContactByEmail null → createContact; hit
 *    → updateContactDetails (re-sync edited user info to Zoho)
 *  - non-hosting items filtered out (only itemType=hosting OR
 *    hostingPlan present pass the gate)
 *  - **registrationPeriod<12 → recurrence_frequency='months' +
 *    create_days_before=7 + start_date=today+1mo**; >=12 →
 *    'years'/30/today+1yr (the renewal-notice + first-charge window
 *    matches what billing UI promises)
 *  - line_items[0].name resolution: hostingPlan.name > 'Hosting
 *    Service' fallback for the 'hosting-XYZ' synthetic-domain pattern
 *  - rate = self._roundAmount(item.price) (so a buggy price like
 *    1023.456 hits Zoho as 1023.46, not the full float)
 *  - per-item exception: try/catch around each item — 1 throw doesn't
 *    abort the loop, the bad item is recorded as success:false and the
 *    next item still processes (independent profile creation)
 *  - top-level try/catch: contact-creation throw → returns [] empty
 *    (rest of flow can't proceed if Zoho contact ID isn't established)
 *  - is_never_expiring:true (cancel via UI, never auto-stop)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const zohoPost = vi.hoisted(() => vi.fn());
vi.mock("@/lib/zohobooks/axios-client", () => ({
  zohoAxios: { post: zohoPost },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { createRecurringInvoice } from "@/lib/zohobooks/recurring";

function makeSelf(opts: Partial<{
  hasToken: boolean;
  contact: { contact_id: string } | null;
}> = {}) {
  return {
    _hasRefreshToken: vi.fn().mockReturnValue(opts.hasToken ?? true),
    _getHeaders: vi.fn().mockResolvedValue({ Authorization: "Zoho-oauthtoken X" }),
    _idempotentRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    _roundAmount: vi.fn((n: number) => Math.round(n * 100) / 100),
    _baseUrl: "https://www.zohoapis.com/books/v3",
    _LOCATION_ID: "LOC_42",
    _defaultParams: { organization_id: "ORG_123" },
    getContactByEmail: vi
      .fn()
      .mockResolvedValue("contact" in opts ? opts.contact : { contact_id: "C_existing" }),
    createContact: vi.fn().mockResolvedValue({ contact_id: "C_new" }),
    updateContactDetails: vi.fn().mockResolvedValue(undefined),
  };
}

const ORDER = { orderId: "ORD_42" } as never;
const USER = { email: "u@example.test" } as never;

beforeEach(() => {
  zohoPost.mockReset();
});

describe("createRecurringInvoice", () => {
  it("returns [] when refresh token isn't configured (lazy-init guard)", async () => {
    const self = makeSelf({ hasToken: false });
    const result = await createRecurringInvoice(self as never, ORDER, USER, []);
    expect(result).toEqual([]);
    expect(zohoPost).not.toHaveBeenCalled();
  });

  it("calls updateContactDetails when getContactByEmail returns a hit (re-sync edits)", async () => {
    const self = makeSelf();
    self.getContactByEmail.mockResolvedValueOnce({ contact_id: "C_HIT" });
    zohoPost.mockResolvedValueOnce({
      data: { code: 0, recurring_invoice: { recurring_invoice_id: "RIP_1" } },
    });
    await createRecurringInvoice(self as never, ORDER, USER, [
      { itemType: "hosting", domainName: "x.com", price: 100, registrationPeriod: 12 } as never,
    ]);
    expect(self.updateContactDetails).toHaveBeenCalledWith("C_HIT", USER);
    expect(self.createContact).not.toHaveBeenCalled();
  });

  it("creates contact when getContactByEmail returns null", async () => {
    const self = makeSelf({ contact: null });
    zohoPost.mockResolvedValueOnce({
      data: { code: 0, recurring_invoice: { recurring_invoice_id: "RIP_1" } },
    });
    await createRecurringInvoice(self as never, ORDER, USER, [
      { itemType: "hosting", domainName: "x.com", price: 100, registrationPeriod: 12 } as never,
    ]);
    expect(self.createContact).toHaveBeenCalled();
    expect(self.updateContactDetails).not.toHaveBeenCalled();
  });

  it("filters out non-hosting items + returns [] when nothing left", async () => {
    const self = makeSelf();
    const result = await createRecurringInvoice(self as never, ORDER, USER, [
      { itemType: "domain", domainName: "x.com", price: 100 } as never,
      { itemType: "domain", domainName: "y.com", price: 200 } as never,
    ]);
    expect(result).toEqual([]);
    expect(zohoPost).not.toHaveBeenCalled();
  });

  it("registrationPeriod<12 → monthly profile (frequency=months, create_days_before=7)", async () => {
    const self = makeSelf();
    zohoPost.mockResolvedValueOnce({
      data: { code: 0, recurring_invoice: { recurring_invoice_id: "RIP_MO" } },
    });
    await createRecurringInvoice(self as never, ORDER, USER, [
      { itemType: "hosting", domainName: "mo.com", price: 100, registrationPeriod: 1 } as never,
    ]);
    const [, body] = zohoPost.mock.calls[0];
    expect(body.recurrence_frequency).toBe("months");
    expect(body.create_days_before).toBe(7);
    expect(body.is_never_expiring).toBe(true);
    expect(body.repeat_every).toBe(1);
  });

  it("registrationPeriod>=12 → yearly profile (frequency=years, create_days_before=30)", async () => {
    const self = makeSelf();
    zohoPost.mockResolvedValueOnce({
      data: { code: 0, recurring_invoice: { recurring_invoice_id: "RIP_YR" } },
    });
    await createRecurringInvoice(self as never, ORDER, USER, [
      { itemType: "hosting", domainName: "yr.com", price: 100, registrationPeriod: 12 } as never,
    ]);
    const [, body] = zohoPost.mock.calls[0];
    expect(body.recurrence_frequency).toBe("years");
    expect(body.create_days_before).toBe(30);
  });

  it("line item: hostingPlan.name takes precedence; else 'Hosting Service' fallback", async () => {
    const self = makeSelf();
    zohoPost
      .mockResolvedValueOnce({
        data: { code: 0, recurring_invoice: { recurring_invoice_id: "R1" } },
      })
      .mockResolvedValueOnce({
        data: { code: 0, recurring_invoice: { recurring_invoice_id: "R2" } },
      });
    await createRecurringInvoice(self as never, ORDER, USER, [
      {
        itemType: "hosting",
        domainName: "hosting-abc",
        hostingPlan: { name: "Pro Plan" },
        price: 100,
        registrationPeriod: 12,
      } as never,
      {
        itemType: "hosting",
        domainName: "hosting-xyz",
        price: 100,
        registrationPeriod: 12,
      } as never,
    ]);
    const [, body1] = zohoPost.mock.calls[0];
    const [, body2] = zohoPost.mock.calls[1];
    expect(body1.line_items[0].name).toBe("Pro Plan");
    expect(body2.line_items[0].name).toBe("Hosting Service");
  });

  it("rate routes through self._roundAmount (defence against float-precision prices)", async () => {
    const self = makeSelf();
    zohoPost.mockResolvedValueOnce({
      data: { code: 0, recurring_invoice: { recurring_invoice_id: "R1" } },
    });
    await createRecurringInvoice(self as never, ORDER, USER, [
      { itemType: "hosting", domainName: "x.com", price: 1023.456, registrationPeriod: 12 } as never,
    ]);
    expect(self._roundAmount).toHaveBeenCalledWith(1023.456);
    const [, body] = zohoPost.mock.calls[0];
    expect(body.line_items[0].rate).toBe(1023.46);
  });

  it("per-item exception doesn't abort the loop — 1 throw, next item still processes", async () => {
    const self = makeSelf();
    zohoPost
      .mockRejectedValueOnce(new Error("rate limit on item 1"))
      .mockResolvedValueOnce({
        data: { code: 0, recurring_invoice: { recurring_invoice_id: "R_GOOD" } },
      });
    const result = await createRecurringInvoice(self as never, ORDER, USER, [
      { itemType: "hosting", domainName: "bad.com", price: 100, registrationPeriod: 12 } as never,
      { itemType: "hosting", domainName: "good.com", price: 100, registrationPeriod: 12 } as never,
    ]);
    expect(result).toEqual([
      { domainName: "bad.com", success: false, error: expect.stringContaining("rate limit") },
      { domainName: "good.com", success: true, recurringInvoiceId: "R_GOOD" },
    ]);
  });

  it("Zoho code != 0 (without throw) → success:false with the Zoho error message", async () => {
    const self = makeSelf();
    zohoPost.mockResolvedValueOnce({
      data: { code: 14001, message: "Subscription limit reached" },
    });
    const result = await createRecurringInvoice(self as never, ORDER, USER, [
      { itemType: "hosting", domainName: "x.com", price: 100, registrationPeriod: 12 } as never,
    ]);
    expect(result).toEqual([
      { domainName: "x.com", success: false, error: "Subscription limit reached" },
    ]);
  });

  it("top-level contact-failure: returns [] empty when contact identification fails", async () => {
    const self = makeSelf({ contact: null });
    self.createContact.mockResolvedValueOnce(null); // both lookup and create return null
    const result = await createRecurringInvoice(self as never, ORDER, USER, [
      { itemType: "hosting", domainName: "x.com", price: 100, registrationPeriod: 12 } as never,
    ]);
    expect(result).toEqual([]);
    expect(zohoPost).not.toHaveBeenCalled();
  });
});
