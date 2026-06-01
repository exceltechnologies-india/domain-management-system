/**
 * Tests for `@/lib/zohobooks/credit-notes` (rescan-4 slice 7ea).
 * Razorpay refund → Zoho credit-note flow. Pins:
 *  - throws ZohoError MISSING_REFRESH_TOKEN when not configured (the
 *    refund handler relies on this to surface a typed sentinel rather
 *    than crash with an axios ENOTFOUND)
 *  - refundAmountPaise → rupees via /100 → self._roundAmount
 *  - reference_number = "REFUND-{razorpayRefundId}" (lets Zoho dedupe
 *    on the natural key — a re-fired webhook can no-op safely)
 *  - line_items has 1 row with quantity:1 + rate=rupees
 *  - 2-step protocol: POST /creditnotes THEN POST
 *    /creditnotes/{id}/invoices to apply against the original invoice
 *  - apply uses the SAME rupee amount (no double-rounding)
 *  - either step's code !== 0 raises a typed ZohoError with the right
 *    sentinel code (CREDITNOTE_CREATE_FAILED vs CREDITNOTE_APPLY_FAILED)
 *  - both HTTP calls route through self._idempotentRetry
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const zohoPost = vi.hoisted(() => vi.fn());
vi.mock("@/lib/zohobooks/axios-client", () => ({
  zohoAxios: { post: zohoPost },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const FakeZohoError = vi.hoisted(
  () =>
    class extends Error {
      type: string;
      code: string;
      constructor(type: string, code: string, message: string) {
        super(message);
        this.type = type;
        this.code = code;
      }
    }
);
vi.mock("@/lib/zohobooks", () => ({
  ZohoError: FakeZohoError,
}));

import { createCreditNote } from "@/lib/zohobooks/credit-notes";

function makeSelf(overrides: Partial<{ hasToken: boolean }> = {}) {
  return {
    _hasRefreshToken: vi.fn().mockReturnValue(overrides.hasToken ?? true),
    _getHeaders: vi.fn().mockResolvedValue({ Authorization: "Zoho-oauthtoken X" }),
    _idempotentRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    _roundAmount: vi.fn((n: number) => Math.round(n * 100) / 100),
    _baseUrl: "https://www.zohoapis.com/books/v3",
    _LOCATION_ID: "LOC_42",
    _defaultParams: { organization_id: "ORG_123" },
  };
}

beforeEach(() => {
  zohoPost.mockReset();
});

describe("createCreditNote", () => {
  it("throws MISSING_REFRESH_TOKEN ZohoError when refresh token is absent", async () => {
    const self = makeSelf({ hasToken: false });
    await expect(
      createCreditNote(self as never, "INV", "CONTACT", "rfnd_1", 10000, "ORD")
    ).rejects.toMatchObject({
      code: "MISSING_REFRESH_TOKEN",
      type: "Config Error",
    });
    expect(zohoPost).not.toHaveBeenCalled();
  });

  it("converts paise → rupees + sets reference_number='REFUND-{refundId}' + 1 line_item", async () => {
    const self = makeSelf();
    zohoPost
      .mockResolvedValueOnce({
        data: { code: 0, creditnote: { creditnote_id: "CN_123" } },
      })
      .mockResolvedValueOnce({ data: { code: 0 } });
    await createCreditNote(self as never, "INV_1", "CONTACT_1", "rfnd_xyz", 25000, "ORD_99");
    const [createUrl, createBody] = zohoPost.mock.calls[0];
    expect(createUrl).toBe("https://www.zohoapis.com/books/v3/creditnotes");
    // 25000 paise → ₹250
    expect(createBody.line_items).toHaveLength(1);
    expect(createBody.line_items[0].rate).toBe(250);
    expect(createBody.line_items[0].quantity).toBe(1);
    expect(createBody.line_items[0].name).toBe("Refund — Order ORD_99");
    expect(createBody.reference_number).toBe("REFUND-rfnd_xyz");
    expect(createBody.customer_id).toBe("CONTACT_1");
    expect(createBody.location_id).toBe("LOC_42");
    expect(self._roundAmount).toHaveBeenCalledWith(250);
  });

  it("applies the credit note against the original invoice with the SAME rupee amount", async () => {
    const self = makeSelf();
    zohoPost
      .mockResolvedValueOnce({
        data: { code: 0, creditnote: { creditnote_id: "CN_xyz" } },
      })
      .mockResolvedValueOnce({ data: { code: 0 } });
    await createCreditNote(self as never, "INV_777", "C_1", "rfnd_1", 50000, "ORD");
    const [applyUrl, applyBody] = zohoPost.mock.calls[1];
    expect(applyUrl).toBe("https://www.zohoapis.com/books/v3/creditnotes/CN_xyz/invoices");
    expect(applyBody).toEqual({
      invoices: [{ invoice_id: "INV_777", amount_applied: 500 }],
    });
  });

  it("step-1 code != 0 throws CREDITNOTE_CREATE_FAILED with the Zoho message", async () => {
    const self = makeSelf();
    zohoPost.mockResolvedValueOnce({
      data: { code: 14001, message: "Invalid contact" },
    });
    await expect(
      createCreditNote(self as never, "INV", "CONTACT", "rfnd_1", 10000, "ORD")
    ).rejects.toMatchObject({
      code: "CREDITNOTE_CREATE_FAILED",
      message: "Invalid contact",
    });
  });

  it("step-1 missing creditnote object also throws CREDITNOTE_CREATE_FAILED", async () => {
    const self = makeSelf();
    zohoPost.mockResolvedValueOnce({ data: { code: 0 } }); // code:0 but no creditnote
    await expect(
      createCreditNote(self as never, "INV", "CONTACT", "rfnd_1", 10000, "ORD")
    ).rejects.toMatchObject({ code: "CREDITNOTE_CREATE_FAILED" });
  });

  it("step-2 code != 0 throws CREDITNOTE_APPLY_FAILED (creation succeeded but apply failed)", async () => {
    const self = makeSelf();
    zohoPost
      .mockResolvedValueOnce({
        data: { code: 0, creditnote: { creditnote_id: "CN_orphan" } },
      })
      .mockResolvedValueOnce({
        data: { code: 9001, message: "Invoice already paid" },
      });
    await expect(
      createCreditNote(self as never, "INV", "CONTACT", "rfnd_1", 10000, "ORD")
    ).rejects.toMatchObject({
      code: "CREDITNOTE_APPLY_FAILED",
      message: "Invoice already paid",
    });
  });

  it("returns the created credit note object on full success", async () => {
    const self = makeSelf();
    const cn = { creditnote_id: "CN_OK", total: 100 };
    zohoPost
      .mockResolvedValueOnce({ data: { code: 0, creditnote: cn } })
      .mockResolvedValueOnce({ data: { code: 0 } });
    const result = await createCreditNote(
      self as never, "INV", "CONTACT", "rfnd_1", 10000, "ORD"
    );
    expect(result).toBe(cn);
  });

  it("both HTTP calls are wrapped in self._idempotentRetry (so transient 503s retry)", async () => {
    const self = makeSelf();
    zohoPost
      .mockResolvedValueOnce({ data: { code: 0, creditnote: { creditnote_id: "X" } } })
      .mockResolvedValueOnce({ data: { code: 0 } });
    await createCreditNote(self as never, "INV", "CONTACT", "rfnd_1", 10000, "ORD");
    expect(self._idempotentRetry).toHaveBeenCalledTimes(2);
  });
});
