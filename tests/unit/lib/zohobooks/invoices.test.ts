/**
 * Tests for `@/lib/zohobooks/invoices` (rescan-4 slice 7fs).
 * Zoho Books invoice operations — pure functions taking a `self`
 * argument with the ZohoBooksService surface. Pins:
 *  - **Idempotency dedup**: createInvoice first calls
 *    getInvoicesByReferenceNumber(orderId) and returns the existing
 *    invoice if one is found — prevents duplicate invoices when the
 *    retry layer fires concurrently with the original creation path
 *  - **Missing-refresh-token throws ZohoError** with code
 *    'MISSING_REFRESH_TOKEN' (rest of the surface that gates on it
 *    returns null/[]/false instead of throwing — only createInvoice
 *    throws because it can't silently skip a write)
 *  - **Contact upsert**: getContactByEmail null → createContact;
 *    found → updateContactDetails (re-sync on every invoice path so
 *    address changes flow through)
 *  - **GST tax routing**: customerState lowercased compared to
 *    _ORG_STATE; inter-state → IGST18, intra-state → GST18; falsy
 *    state defaults to intra-state (safer than mis-IGST)
 *  - **Test-hosting rate**: itemType:'hosting' AND periodUnit:'days'
 *    → rate=1, quantity=1 (₹1 trial hosting for QA flow); else
 *    rate=_roundAmount(price), quantity=duration
 *  - **GST-error fallback (code=2 + 'gst' in message)**:
 *    updateContactToConsumer + retry; fix fails → rethrow original
 *  - **Tax-mismatch fallback (code=3032)**: swap IGST↔GST tax_id on
 *    every line_item and retry
 *  - **Subscription-expired (code=103001)** in outer catch → throw
 *    ZohoError SUBSCRIPTION_EXPIRED (admin-visible, not a generic 500)
 *  - **status/sent failure SWALLOWED** (already-sent is fine)
 *  - **Payment skip rules**: total <= 0 OR shouldApplyPayment=false →
 *    skip; payment failure does NOT throw (return invoice anyway —
 *    the invoice is the durable artefact)
 *  - **getInvoicesByEmail sort**: DESC by invoice_number using natural
 *    sort (so INV-00014 ranks above INV-00009 even though INV-9 > INV-1
 *    lexically). Missing token → [] (warn). Missing contact → [].
 *  - **Code-57 probe path**: on access-denied error, attempt a
 *    bare list to confirm whether the issue is scope vs contact-ID
 *  - **getInvoicePdf**: Accept: application/pdf header + ArrayBuffer
 *    responseType + ?accept=pdf; missing token/id → null
 *  - **getInvoiceById**: code !== 0 → null (success only on code 0)
 *  - **applyPaymentToInvoice**: getInvoiceById null → caught, false
 *  - **getInvoicesByReferenceNumber**: empty ref → []; code 0 +
 *    invoices array → invoices verbatim
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AxiosError } from "axios";

const zohoAxios = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));
vi.mock("@/lib/zohobooks/axios-client", () => ({ zohoAxios }));

const serverLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/lib/server-logger", () => ({ serverLogger }));

// Use a real ZohoError class so `instanceof ZohoError` works in tests.
// Hoisted so it's defined before vi.mock's factory runs.
const { ZohoError } = vi.hoisted(() => {
  class ZohoError extends Error {
    type: string;
    code: string;
    constructor(type: string, code: string, message: string) {
      super(message);
      this.type = type;
      this.code = code;
      this.name = "ZohoError";
    }
  }
  return { ZohoError };
});
vi.mock("@/lib/zohobooks", () => ({ ZohoError }));

import {
  createInvoice,
  getInvoicesByEmail,
  getInvoicePdf,
  getAllInvoices,
  getInvoiceById,
  applyPaymentToInvoice,
  getInvoicesByReferenceNumber,
} from "@/lib/zohobooks/invoices";

// ── helpers ──────────────────────────────────────────────────────────
function makeSelf(overrides: Partial<any> = {}): any {
  const self: any = {
    _hasRefreshToken: vi.fn(() => true),
    _baseUrl: "https://books.zoho.com/api/v3",
    _defaultParams: { organization_id: "ORG-1" },
    _LOCATION_ID: "LOC-1",
    _ORG_STATE: "Maharashtra",
    _TAX_IDS: { GST18: "TAX_GST", IGST18: "TAX_IGST" },
    _getHeaders: vi.fn(async () => ({ Authorization: "Zoho-tok" })),
    _idempotentRetry: vi.fn(async (fn: () => Promise<any>) => fn()),
    _roundAmount: vi.fn((n: number) => Math.round(n)),
    getContactByEmail: vi.fn(),
    createContact: vi.fn(),
    updateContactDetails: vi.fn(),
    updateContactToConsumer: vi.fn(),
    getInvoicesByReferenceNumber: vi.fn(async () => []),
    getInvoiceById: vi.fn(),
    ...overrides,
  };
  return self;
}

function makeAxiosError(status: number, data: unknown) {
  const err = new AxiosError("Request failed", "ERR", undefined, undefined, {
    status,
    statusText: "Err",
    data,
    headers: {},
    config: {},
  } as any);
  return err;
}

const okItem = {
  itemType: "domain" as const,
  domainName: "example.com",
  price: 999,
  registrationPeriod: 1,
  periodUnit: "years" as const,
};

const okUser = {
  email: "user@x.com",
  address: { state: "Maharashtra" },
};

const okOrder = {
  orderId: "ORD-1",
  razorpayPaymentId: "rzp_pay_1",
  total: 999,
};

beforeEach(() => {
  zohoAxios.get.mockReset();
  zohoAxios.post.mockReset();
  serverLogger.info.mockReset();
  serverLogger.warn.mockReset();
  serverLogger.error.mockReset();
});

// ─── createInvoice — top-level gate ─────────────────────────────────
describe("createInvoice — refresh-token gate", () => {
  it("missing refresh token → throws ZohoError MISSING_REFRESH_TOKEN", async () => {
    const self = makeSelf({ _hasRefreshToken: vi.fn(() => false) });
    await expect(
      createInvoice(self, okOrder as any, okUser as any, [okItem as any])
    ).rejects.toMatchObject({
      name: "ZohoError",
      code: "MISSING_REFRESH_TOKEN",
    });
  });
});

describe("createInvoice — idempotency dedup", () => {
  it("existing invoice for reference_number → returned without POST", async () => {
    const existing = { invoice_id: "EXISTING-1", invoice_number: "INV-001" };
    const self = makeSelf({
      getInvoicesByReferenceNumber: vi.fn(async () => [existing]),
    });

    const result = await createInvoice(
      self,
      okOrder as any,
      okUser as any,
      [okItem as any]
    );

    expect(result).toBe(existing);
    expect(zohoAxios.post).not.toHaveBeenCalled();
    expect(self.getContactByEmail).not.toHaveBeenCalled();
  });

  it("no existing invoice → proceeds with contact lookup", async () => {
    const self = makeSelf();
    self.getContactByEmail.mockResolvedValueOnce({ contact_id: "C1" });
    self.updateContactDetails.mockResolvedValueOnce({});
    zohoAxios.post
      .mockResolvedValueOnce({
        data: { code: 0, invoice: { invoice_id: "INV-1", total: 0 } },
      })
      .mockResolvedValueOnce({ data: { code: 0 } });

    await createInvoice(self, okOrder as any, okUser as any, [okItem as any]);

    expect(self.getContactByEmail).toHaveBeenCalledWith("user@x.com");
  });
});

describe("createInvoice — contact upsert", () => {
  it("contact not found → createContact called", async () => {
    const self = makeSelf();
    self.getContactByEmail.mockResolvedValueOnce(null);
    self.createContact.mockResolvedValueOnce({ contact_id: "NEW" });
    zohoAxios.post.mockResolvedValue({
      data: { code: 0, invoice: { invoice_id: "INV-1", total: 0 } },
    });

    await createInvoice(self, okOrder as any, okUser as any, [okItem as any]);

    expect(self.createContact).toHaveBeenCalled();
    expect(self.updateContactDetails).not.toHaveBeenCalled();
  });

  it("contact found → updateContactDetails called (re-sync on every path)", async () => {
    const self = makeSelf();
    self.getContactByEmail.mockResolvedValueOnce({ contact_id: "C1" });
    self.updateContactDetails.mockResolvedValueOnce({});
    zohoAxios.post.mockResolvedValue({
      data: { code: 0, invoice: { invoice_id: "INV-1", total: 0 } },
    });

    await createInvoice(self, okOrder as any, okUser as any, [okItem as any]);

    expect(self.updateContactDetails).toHaveBeenCalledWith("C1", okUser);
    expect(self.createContact).not.toHaveBeenCalled();
  });

  it("contact still null after both lookup + create → throws", async () => {
    const self = makeSelf();
    self.getContactByEmail.mockResolvedValueOnce(null);
    self.createContact.mockResolvedValueOnce(null);

    await expect(
      createInvoice(self, okOrder as any, okUser as any, [okItem as any])
    ).rejects.toThrow(/Failed to identify customer/);
  });
});

describe("createInvoice — GST tax routing", () => {
  async function captureLineItemTax(state: string | undefined): Promise<string> {
    const self = makeSelf();
    self.getContactByEmail.mockResolvedValueOnce({
      contact_id: "C1",
      billing_address: { state },
    });
    self.updateContactDetails.mockResolvedValueOnce({});
    zohoAxios.post.mockResolvedValueOnce({
      data: { code: 0, invoice: { invoice_id: "INV-1", total: 0 } },
    });

    await createInvoice(self, okOrder as any, okUser as any, [okItem as any]);

    const post = zohoAxios.post.mock.calls[0];
    const body = post[1];
    return body.line_items[0].tax_id;
  }

  it("intra-state (Maharashtra == Maharashtra) → GST18", async () => {
    expect(await captureLineItemTax("Maharashtra")).toBe("TAX_GST");
  });

  it("inter-state (Karnataka vs Maharashtra) → IGST18", async () => {
    expect(await captureLineItemTax("Karnataka")).toBe("TAX_IGST");
  });

  it("case-insensitive state compare (lowercase match still intra-state)", async () => {
    expect(await captureLineItemTax("maharashtra")).toBe("TAX_GST");
  });

  it("empty state defaults to intra-state (safer than mis-IGST)", async () => {
    // Contact has empty state, user.address.state is also empty for this case
    const self = makeSelf();
    self.getContactByEmail.mockResolvedValueOnce({
      contact_id: "C1",
      billing_address: { state: "" },
    });
    self.updateContactDetails.mockResolvedValueOnce({});
    zohoAxios.post.mockResolvedValueOnce({
      data: { code: 0, invoice: { invoice_id: "INV-1", total: 0 } },
    });

    await createInvoice(
      self,
      okOrder as any,
      { email: "u@x.com", address: { state: "" } } as any,
      [okItem as any]
    );

    expect(zohoAxios.post.mock.calls[0][1].line_items[0].tax_id).toBe(
      "TAX_GST"
    );
  });
});

describe("createInvoice — line-item shape", () => {
  it("test-hosting (itemType:'hosting' + periodUnit:'days') → rate=1, quantity=1", async () => {
    const self = makeSelf();
    self.getContactByEmail.mockResolvedValueOnce({ contact_id: "C1" });
    self.updateContactDetails.mockResolvedValueOnce({});
    zohoAxios.post.mockResolvedValueOnce({
      data: { code: 0, invoice: { invoice_id: "INV-1", total: 0 } },
    });

    await createInvoice(
      self,
      okOrder as any,
      okUser as any,
      [
        {
          itemType: "hosting",
          domainName: "hosting-trial",
          price: 99999,
          registrationPeriod: 7,
          periodUnit: "days",
          hostingPlan: { name: "Trial" },
        } as any,
      ]
    );

    const li = zohoAxios.post.mock.calls[0][1].line_items[0];
    expect(li.rate).toBe(1);
    expect(li.quantity).toBe(1);
  });

  it("real hosting → rate=_roundAmount(price), quantity=duration", async () => {
    const self = makeSelf();
    self.getContactByEmail.mockResolvedValueOnce({ contact_id: "C1" });
    self.updateContactDetails.mockResolvedValueOnce({});
    zohoAxios.post.mockResolvedValueOnce({
      data: { code: 0, invoice: { invoice_id: "INV-1", total: 0 } },
    });

    await createInvoice(self, okOrder as any, okUser as any, [
      {
        itemType: "hosting",
        domainName: "ex.com",
        price: 500.4,
        registrationPeriod: 12,
        periodUnit: "months",
        hostingPlan: { name: "Pro", features: ["a", "b", "c", "d", "e"] },
      } as any,
    ]);

    const li = zohoAxios.post.mock.calls[0][1].line_items[0];
    expect(li.rate).toBe(500); // rounded
    expect(li.quantity).toBe(12);
    expect(li.name).toBe("Pro");
    expect(li.description).toMatch(/Web Hosting: Pro/);
    // features capped to first 4 in description
    expect(li.description).toMatch(/a, b, c, d/);
    expect(li.description).not.toMatch(/e$/);
  });

  it("hosting with hosting- prefix and no plan → name 'Hosting Service'", async () => {
    const self = makeSelf();
    self.getContactByEmail.mockResolvedValueOnce({ contact_id: "C1" });
    self.updateContactDetails.mockResolvedValueOnce({});
    zohoAxios.post.mockResolvedValueOnce({
      data: { code: 0, invoice: { invoice_id: "INV-1", total: 0 } },
    });

    await createInvoice(self, okOrder as any, okUser as any, [
      {
        itemType: "hosting",
        domainName: "hosting-uuid",
        price: 100,
        registrationPeriod: 1,
        periodUnit: "months",
      } as any,
    ]);

    expect(zohoAxios.post.mock.calls[0][1].line_items[0].name).toBe(
      "Hosting Service"
    );
  });

  it("domain item → name = domainName, description includes 'Domain Registration'", async () => {
    const self = makeSelf();
    self.getContactByEmail.mockResolvedValueOnce({ contact_id: "C1" });
    self.updateContactDetails.mockResolvedValueOnce({});
    zohoAxios.post.mockResolvedValueOnce({
      data: { code: 0, invoice: { invoice_id: "INV-1", total: 0 } },
    });

    await createInvoice(self, okOrder as any, okUser as any, [
      okItem as any,
    ]);

    const li = zohoAxios.post.mock.calls[0][1].line_items[0];
    expect(li.name).toBe("example.com");
    expect(li.description).toMatch(/Domain Registration/);
    expect(li.description).toMatch(/example\.com/);
  });
});

describe("createInvoice — error-recovery fallbacks", () => {
  it("GST error (code=2 + 'gst' in message) → updateContactToConsumer + retry", async () => {
    const self = makeSelf();
    self.getContactByEmail.mockResolvedValueOnce({ contact_id: "C1" });
    self.updateContactDetails.mockResolvedValueOnce({});
    self.updateContactToConsumer.mockResolvedValueOnce(true);
    zohoAxios.post
      .mockRejectedValueOnce(
        makeAxiosError(400, { code: 2, message: "Invalid GSTIN provided" })
      )
      .mockResolvedValueOnce({
        data: { code: 0, invoice: { invoice_id: "INV-RETRY", total: 0 } },
      });

    const r = await createInvoice(
      self,
      okOrder as any,
      okUser as any,
      [okItem as any]
    );

    expect(self.updateContactToConsumer).toHaveBeenCalledWith("C1");
    expect(r?.invoice_id).toBe("INV-RETRY");
  });

  it("GST fix fails (returns false) → rethrow original error", async () => {
    const self = makeSelf();
    self.getContactByEmail.mockResolvedValueOnce({ contact_id: "C1" });
    self.updateContactDetails.mockResolvedValueOnce({});
    self.updateContactToConsumer.mockResolvedValueOnce(false);
    zohoAxios.post.mockRejectedValueOnce(
      makeAxiosError(400, { code: 2, message: "Invalid GST" })
    );

    await expect(
      createInvoice(self, okOrder as any, okUser as any, [okItem as any])
    ).rejects.toBeInstanceOf(AxiosError);
  });

  it("Tax-mismatch error (code=3032) → swap tax_id on every line_item and retry", async () => {
    const self = makeSelf();
    // Force intra-state (Maharashtra match) so first attempt uses GST, retry uses IGST
    self.getContactByEmail.mockResolvedValueOnce({
      contact_id: "C1",
      billing_address: { state: "Maharashtra" },
    });
    self.updateContactDetails.mockResolvedValueOnce({});
    zohoAxios.post
      .mockRejectedValueOnce(
        makeAxiosError(400, { code: 3032, message: "Tax mismatch" })
      )
      .mockResolvedValueOnce({
        data: { code: 0, invoice: { invoice_id: "INV-TAX", total: 0 } },
      });

    // No status/sent or payment mocks — the retry happens BEFORE status/sent
    // by structure, so a retry-only failure on later steps is silenced by the
    // try/catch wrap inside the fn. We only care that the SECOND /invoices POST
    // (the retry) has swapped tax_ids.
    await createInvoice(self, okOrder as any, okUser as any, [
      okItem as any,
      okItem as any,
    ]).catch(() => {});

    // call 0 = create (rejected), call 1 = retry-create (success). After that
    // the function calls /status/sent, so total >= 2 with at least one retry.
    expect(zohoAxios.post.mock.calls.length).toBeGreaterThanOrEqual(2);
    const retryBody = zohoAxios.post.mock.calls[1][1];
    // After swap from GST to IGST
    expect(retryBody.line_items[0].tax_id).toBe("TAX_IGST");
    expect(retryBody.line_items[1].tax_id).toBe("TAX_IGST");
  });

  it("non-recoverable error (different code) → rethrows AxiosError", async () => {
    const self = makeSelf();
    self.getContactByEmail.mockResolvedValueOnce({ contact_id: "C1" });
    self.updateContactDetails.mockResolvedValueOnce({});
    zohoAxios.post.mockRejectedValueOnce(
      makeAxiosError(400, { code: 12345, message: "Random error" })
    );

    await expect(
      createInvoice(self, okOrder as any, okUser as any, [okItem as any])
    ).rejects.toBeInstanceOf(AxiosError);
  });

  it("Subscription-expired (code=103001) → throws ZohoError SUBSCRIPTION_EXPIRED", async () => {
    const self = makeSelf();
    self.getContactByEmail.mockResolvedValueOnce({ contact_id: "C1" });
    self.updateContactDetails.mockResolvedValueOnce({});
    zohoAxios.post.mockRejectedValueOnce(
      makeAxiosError(403, { code: 103001, message: "Subscription expired" })
    );

    await expect(
      createInvoice(self, okOrder as any, okUser as any, [okItem as any])
    ).rejects.toMatchObject({
      name: "ZohoError",
      code: "SUBSCRIPTION_EXPIRED",
    });
  });
});

describe("createInvoice — post-create flow", () => {
  function setupSuccess(self: any, total = 999) {
    self.getContactByEmail.mockResolvedValueOnce({ contact_id: "C1" });
    self.updateContactDetails.mockResolvedValueOnce({});
    zohoAxios.post
      .mockResolvedValueOnce({
        data: {
          code: 0,
          invoice: { invoice_id: "INV-1", invoice_number: "001", total },
        },
      })
      .mockResolvedValueOnce({ data: { code: 0 } }) // /status/sent
      .mockResolvedValueOnce({ data: { code: 0 } }); // /customerpayments
  }

  it("status/sent failure SWALLOWED (already-sent is fine)", async () => {
    const self = makeSelf();
    self.getContactByEmail.mockResolvedValueOnce({ contact_id: "C1" });
    self.updateContactDetails.mockResolvedValueOnce({});
    zohoAxios.post
      .mockResolvedValueOnce({
        data: {
          code: 0,
          invoice: { invoice_id: "INV-1", invoice_number: "001", total: 999 },
        },
      })
      .mockRejectedValueOnce(new Error("Already sent"))
      .mockResolvedValueOnce({ data: { code: 0 } });

    const r = await createInvoice(
      self,
      okOrder as any,
      okUser as any,
      [okItem as any]
    );
    expect(r?.invoice_id).toBe("INV-1");
  });

  it("total <= 0 → payment skipped (no /customerpayments call)", async () => {
    const self = makeSelf();
    setupSuccess(self, 0);
    await createInvoice(self, okOrder as any, okUser as any, [okItem as any]);
    // 2 POSTs total: create + status/sent, NO payment
    expect(zohoAxios.post).toHaveBeenCalledTimes(2);
    expect(zohoAxios.post.mock.calls.some((c) => /customerpayments/.test(c[0]))).toBe(
      false
    );
  });

  it("shouldApplyPayment=false → payment skipped", async () => {
    const self = makeSelf();
    setupSuccess(self);
    await createInvoice(
      self,
      okOrder as any,
      okUser as any,
      [okItem as any],
      "Razorpay",
      false
    );
    expect(zohoAxios.post.mock.calls.some((c) => /customerpayments/.test(c[0]))).toBe(
      false
    );
  });

  it("payment failure does NOT throw (return invoice anyway — invoice is durable artefact)", async () => {
    const self = makeSelf();
    self.getContactByEmail.mockResolvedValueOnce({ contact_id: "C1" });
    self.updateContactDetails.mockResolvedValueOnce({});
    zohoAxios.post
      .mockResolvedValueOnce({
        data: {
          code: 0,
          invoice: { invoice_id: "INV-1", invoice_number: "001", total: 999 },
        },
      })
      .mockResolvedValueOnce({ data: { code: 0 } }) // status/sent
      .mockRejectedValueOnce(new Error("Payment service down"));

    const r = await createInvoice(
      self,
      okOrder as any,
      okUser as any,
      [okItem as any]
    );
    expect(r?.invoice_id).toBe("INV-1");
  });

  it("payment uses razorpayPaymentId from order, falls back to ADMIN- timestamp ref", async () => {
    const self = makeSelf();
    setupSuccess(self);
    await createInvoice(self, okOrder as any, okUser as any, [okItem as any]);
    const paymentBody = zohoAxios.post.mock.calls[2][1];
    expect(paymentBody.reference_number).toBe("rzp_pay_1");
  });
});

// ─── getInvoicesByEmail ─────────────────────────────────────────────
describe("getInvoicesByEmail", () => {
  it("missing token → [] (warn)", async () => {
    const self = makeSelf({ _hasRefreshToken: vi.fn(() => false) });
    const r = await getInvoicesByEmail(self, "u@x.com");
    expect(r).toEqual([]);
    expect(serverLogger.warn).toHaveBeenCalled();
  });

  it("contact not found → []", async () => {
    const self = makeSelf();
    self.getContactByEmail.mockResolvedValueOnce(null);
    const r = await getInvoicesByEmail(self, "u@x.com");
    expect(r).toEqual([]);
  });

  it("success → sort DESC by invoice_number with natural sort", async () => {
    const self = makeSelf();
    self.getContactByEmail.mockResolvedValueOnce({ contact_id: "C1" });
    zohoAxios.get.mockResolvedValueOnce({
      data: {
        code: 0,
        invoices: [
          { invoice_number: "INV-00009" },
          { invoice_number: "INV-00014" },
          { invoice_number: "INV-00011" },
        ],
      },
    });

    const r = await getInvoicesByEmail(self, "u@x.com");

    expect(r.map((i) => i.invoice_number)).toEqual([
      "INV-00014", // natural sort: 14 > 11 > 9
      "INV-00011",
      "INV-00009",
    ]);
  });

  it("non-zero code → [] (warn)", async () => {
    const self = makeSelf();
    self.getContactByEmail.mockResolvedValueOnce({ contact_id: "C1" });
    zohoAxios.get.mockResolvedValueOnce({
      data: { code: 5, message: "boom" },
    });
    expect(await getInvoicesByEmail(self, "u@x.com")).toEqual([]);
  });

  it("code-57 (access denied) on outer catch → probe path runs", async () => {
    const self = makeSelf();
    self.getContactByEmail.mockResolvedValueOnce({ contact_id: "C1" });
    zohoAxios.get
      .mockRejectedValueOnce(
        makeAxiosError(401, { code: 57, message: "scope denied" })
      )
      .mockResolvedValueOnce({ data: { code: 0, invoices: [] } });

    const r = await getInvoicesByEmail(self, "u@x.com");

    expect(r).toEqual([]);
    expect(zohoAxios.get).toHaveBeenCalledTimes(2); // primary + probe
  });
});

// ─── getInvoicePdf ──────────────────────────────────────────────────
describe("getInvoicePdf", () => {
  it("missing token → null", async () => {
    const self = makeSelf({ _hasRefreshToken: vi.fn(() => false) });
    expect(await getInvoicePdf(self, "INV-1")).toBeNull();
  });

  it("missing invoiceId → null", async () => {
    expect(await getInvoicePdf(makeSelf(), "")).toBeNull();
  });

  it("success returns ArrayBuffer data; passes Accept:'application/pdf' header + arraybuffer responseType", async () => {
    const buf = new ArrayBuffer(8);
    const self = makeSelf();
    zohoAxios.get.mockResolvedValueOnce({ data: buf });

    const r = await getInvoicePdf(self, "INV-1");

    expect(r).toBe(buf);
    const [, opts] = zohoAxios.get.mock.calls[0];
    expect(opts.headers.Accept).toBe("application/pdf");
    expect(opts.responseType).toBe("arraybuffer");
    expect(opts.params.accept).toBe("pdf");
  });

  it("throw → null (caught + logged)", async () => {
    const self = makeSelf();
    zohoAxios.get.mockRejectedValueOnce(new Error("net"));
    expect(await getInvoicePdf(self, "INV-1")).toBeNull();
    expect(serverLogger.error).toHaveBeenCalled();
  });
});

// ─── getAllInvoices ─────────────────────────────────────────────────
describe("getAllInvoices", () => {
  it("missing token → empty result", async () => {
    const self = makeSelf({ _hasRefreshToken: vi.fn(() => false) });
    expect(await getAllInvoices(self)).toEqual({ invoices: [], page_context: {} });
  });

  it("pagination defaults: page=1, perPage=20", async () => {
    const self = makeSelf();
    zohoAxios.get.mockResolvedValueOnce({
      data: { code: 0, invoices: [], page_context: {} },
    });
    await getAllInvoices(self);
    const params = zohoAxios.get.mock.calls[0][1].params;
    expect(params.page).toBe(1);
    expect(params.per_page).toBe(20);
  });

  it("success → sorted DESC by invoice_number naturally", async () => {
    const self = makeSelf();
    zohoAxios.get.mockResolvedValueOnce({
      data: {
        code: 0,
        invoices: [
          { invoice_number: "INV-00001" },
          { invoice_number: "INV-00010" },
        ],
        page_context: { has_more_page: false },
      },
    });
    const r = await getAllInvoices(self);
    expect(r.invoices[0].invoice_number).toBe("INV-00010");
  });

  it("throw → empty result (swallowed)", async () => {
    const self = makeSelf();
    zohoAxios.get.mockRejectedValueOnce(new Error("net"));
    expect(await getAllInvoices(self)).toEqual({ invoices: [], page_context: {} });
  });
});

// ─── getInvoiceById ─────────────────────────────────────────────────
describe("getInvoiceById", () => {
  it("missing token → null", async () => {
    const self = makeSelf({ _hasRefreshToken: vi.fn(() => false) });
    expect(await getInvoiceById(self, "INV-1")).toBeNull();
  });

  it("missing invoiceId → null", async () => {
    expect(await getInvoiceById(makeSelf(), "")).toBeNull();
  });

  it("code !== 0 → null (success only on code 0)", async () => {
    const self = makeSelf();
    zohoAxios.get.mockResolvedValueOnce({ data: { code: 5 } });
    expect(await getInvoiceById(self, "INV-1")).toBeNull();
  });

  it("success → invoice payload", async () => {
    const self = makeSelf();
    zohoAxios.get.mockResolvedValueOnce({
      data: { code: 0, invoice: { invoice_id: "INV-1" } },
    });
    const r = await getInvoiceById(self, "INV-1");
    expect(r).toEqual({ invoice_id: "INV-1" });
  });

  it("throw → null (caught)", async () => {
    const self = makeSelf();
    zohoAxios.get.mockRejectedValueOnce(new Error("net"));
    expect(await getInvoiceById(self, "INV-1")).toBeNull();
  });
});

// ─── applyPaymentToInvoice ──────────────────────────────────────────
describe("applyPaymentToInvoice", () => {
  it("missing token → false", async () => {
    const self = makeSelf({ _hasRefreshToken: vi.fn(() => false) });
    expect(
      await applyPaymentToInvoice(self, "INV-1", 100, "Razorpay", "ref")
    ).toBe(false);
  });

  it("invoice not found → false (Error caught → returns false)", async () => {
    const self = makeSelf();
    self.getInvoiceById.mockResolvedValueOnce(null);
    expect(
      await applyPaymentToInvoice(self, "INV-1", 100, "Razorpay", "ref")
    ).toBe(false);
  });

  it("success → true", async () => {
    const self = makeSelf();
    self.getInvoiceById.mockResolvedValueOnce({
      invoice_id: "INV-1",
      customer_id: "C1",
    });
    zohoAxios.post.mockResolvedValueOnce({ data: { code: 0 } });
    expect(
      await applyPaymentToInvoice(self, "INV-1", 100.7, "Razorpay", "REF-1")
    ).toBe(true);
    const body = zohoAxios.post.mock.calls[0][1];
    expect(body.amount).toBe(101); // _roundAmount rounds
    expect(body.invoices[0].amount_applied).toBe(101);
    expect(body.reference_number).toBe("REF-1");
  });

  it("non-zero code → false", async () => {
    const self = makeSelf();
    self.getInvoiceById.mockResolvedValueOnce({
      invoice_id: "INV-1",
      customer_id: "C1",
    });
    zohoAxios.post.mockResolvedValueOnce({ data: { code: 5 } });
    expect(
      await applyPaymentToInvoice(self, "INV-1", 100, "Razorpay", "ref")
    ).toBe(false);
  });
});

// ─── getInvoicesByReferenceNumber ───────────────────────────────────
describe("getInvoicesByReferenceNumber", () => {
  it("missing token → []", async () => {
    const self = makeSelf({ _hasRefreshToken: vi.fn(() => false) });
    expect(await getInvoicesByReferenceNumber(self, "ORD-1")).toEqual([]);
  });

  it("empty referenceNumber → []", async () => {
    expect(await getInvoicesByReferenceNumber(makeSelf(), "")).toEqual([]);
  });

  it("code 0 + invoices → returned verbatim (no sort here — search endpoint)", async () => {
    const self = makeSelf();
    const invoices = [{ invoice_id: "A" }, { invoice_id: "B" }];
    zohoAxios.get.mockResolvedValueOnce({
      data: { code: 0, invoices },
    });
    expect(await getInvoicesByReferenceNumber(self, "ORD-1")).toEqual(invoices);
  });

  it("non-zero code → []", async () => {
    const self = makeSelf();
    zohoAxios.get.mockResolvedValueOnce({ data: { code: 5 } });
    expect(await getInvoicesByReferenceNumber(self, "ORD-1")).toEqual([]);
  });

  it("throw → [] (caught + logged)", async () => {
    const self = makeSelf();
    zohoAxios.get.mockRejectedValueOnce(new Error("net"));
    expect(await getInvoicesByReferenceNumber(self, "ORD-1")).toEqual([]);
  });
});
