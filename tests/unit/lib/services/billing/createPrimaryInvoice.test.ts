/**
 * Tests for `@/lib/services/billing/createPrimaryInvoice` — the chokepoint
 * that decides whether the new GST engine or Zoho issues an order's tax
 * invoice. Every collaborator is mocked so this suite pins the DECISION
 * LOGIC only (flag check, zero-amount/trial skip, claim, fallback-on-any-
 * failure) — the GST math and numbering atomicity are covered by
 * tests/unit/lib/billing/gst.test.ts and
 * tests/integration/lib/billing/invoiceNumber.test.ts.
 *
 * Pins:
 *  - flag OFF (default) -> calls createZohoInvoice directly, no primary
 *    machinery touched at all
 *  - zero-amount / hosting_trial order -> skipped BEFORE the flag is even
 *    consulted (matches createZohoInvoice's own Trial order invoice policy)
 *  - flag ON + claim fails (concurrent request already handling it) ->
 *    silent skip, NOT a fallback-to-Zoho case
 *  - flag ON + happy path -> gst breakdown computed, number allocated,
 *    recorded on the order, Zoho never called
 *  - flag ON + ANY throw (missing org state, allocation failure, record
 *    failure) -> claim released, falls back to createZohoInvoice
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const isPrimaryBillingEnabled = vi.hoisted(() => vi.fn());
vi.mock("@/lib/primary-billing-flag", () => ({ isPrimaryBillingEnabled }));

const getCompanyProfile = vi.hoisted(() => vi.fn());
vi.mock("@/lib/billing/companyProfile", () => ({ getCompanyProfile }));

const computeGstBreakdown = vi.hoisted(() => vi.fn());
const placeOfSupply = vi.hoisted(() => vi.fn((s: string | undefined) => s || "N/A"));
vi.mock("@/lib/billing/gst", () => ({ computeGstBreakdown, placeOfSupply }));

const allocateInvoiceNumber = vi.hoisted(() => vi.fn());
vi.mock("@/lib/billing/invoiceNumber", () => ({ allocateInvoiceNumber }));

const claimOrderForPrimaryInvoice = vi.hoisted(() => vi.fn());
const releasePrimaryInvoiceClaim = vi.hoisted(() => vi.fn());
const recordPrimaryInvoiceForOrder = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  claimOrderForPrimaryInvoice,
  releasePrimaryInvoiceClaim,
  recordPrimaryInvoiceForOrder,
}));

const createZohoInvoice = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/payment/post-tasks", () => ({ createZohoInvoice }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createPrimaryInvoice } = await import("@/lib/services/billing/createPrimaryInvoice");

const order = {
  _id: "OID-1",
  orderId: "ORD-1",
  amount: 1180,
  orderType: "domain",
} as any;

const user = {
  _id: "U1",
  address: { state: "Maharashtra" },
  gstNumber: "27AAAAA0000A1Z5",
} as any;

function baseCtx(overrides: Record<string, unknown> = {}) {
  return {
    order,
    orderId: "ORD-1",
    razorpay_payment_id: "pay_1",
    paymentDetails: { amount: 1180 },
    user,
    cartItems: [],
    ...overrides,
  } as any;
}

beforeEach(() => {
  isPrimaryBillingEnabled.mockReset().mockReturnValue(false);
  getCompanyProfile.mockReset().mockReturnValue({ state: "Delhi", name: "Co", gstin: "07X" });
  computeGstBreakdown.mockReset().mockReturnValue({
    gstRate: 18,
    taxableValue: 1000,
    cgst: 0,
    sgst: 0,
    igst: 180,
  });
  allocateInvoiceNumber.mockReset().mockResolvedValue("TI/2026-27/00001");
  claimOrderForPrimaryInvoice.mockReset().mockResolvedValue(true);
  releasePrimaryInvoiceClaim.mockReset().mockResolvedValue(undefined);
  recordPrimaryInvoiceForOrder.mockReset().mockResolvedValue(undefined);
  createZohoInvoice.mockReset().mockResolvedValue({ invoiceId: "zoho-1", invoiceNumber: "ZOHO-1" });
});

describe("flag OFF (default)", () => {
  it("delegates straight to createZohoInvoice; no primary machinery touched", async () => {
    const result = await createPrimaryInvoice(baseCtx());
    expect(result).toEqual({ invoiceId: "zoho-1", invoiceNumber: "ZOHO-1" });
    expect(createZohoInvoice).toHaveBeenCalledWith(baseCtx(), {});
    expect(claimOrderForPrimaryInvoice).not.toHaveBeenCalled();
    expect(allocateInvoiceNumber).not.toHaveBeenCalled();
  });

  it("forwards options.claimOptions to createZohoInvoice (recovery-path support)", async () => {
    const options = { claimOptions: { staleClaimAfterMs: 5 * 60 * 1000 } };
    await createPrimaryInvoice(baseCtx(), options);
    expect(createZohoInvoice).toHaveBeenCalledWith(baseCtx(), options);
  });
});

describe("zero-amount / trial skip (applies regardless of flag)", () => {
  it("amount <= 0 -> skipped silently, Zoho never called", async () => {
    isPrimaryBillingEnabled.mockReturnValue(true);
    const result = await createPrimaryInvoice(baseCtx({ order: { ...order, amount: 0 } }));
    expect(result).toEqual({ invoiceId: "", invoiceNumber: null });
    expect(createZohoInvoice).not.toHaveBeenCalled();
    expect(claimOrderForPrimaryInvoice).not.toHaveBeenCalled();
  });

  it("orderType hosting_trial -> skipped silently", async () => {
    isPrimaryBillingEnabled.mockReturnValue(true);
    const result = await createPrimaryInvoice(
      baseCtx({ order: { ...order, orderType: "hosting_trial" } })
    );
    expect(result).toEqual({ invoiceId: "", invoiceNumber: null });
    expect(createZohoInvoice).not.toHaveBeenCalled();
  });
});

describe("flag ON — claim contention", () => {
  it("claim fails (already claimed/issued) -> silent skip, NOT a Zoho fallback", async () => {
    isPrimaryBillingEnabled.mockReturnValue(true);
    claimOrderForPrimaryInvoice.mockResolvedValue(false);
    const result = await createPrimaryInvoice(baseCtx());
    expect(result).toEqual({ invoiceId: "", invoiceNumber: null });
    expect(createZohoInvoice).not.toHaveBeenCalled();
    expect(allocateInvoiceNumber).not.toHaveBeenCalled();
  });
});

describe("flag ON — happy path", () => {
  it("computes breakdown, allocates a number, records it, and never calls Zoho", async () => {
    isPrimaryBillingEnabled.mockReturnValue(true);
    const result = await createPrimaryInvoice(baseCtx());
    expect(result).toEqual({ invoiceId: "TI/2026-27/00001", invoiceNumber: "TI/2026-27/00001" });
    expect(claimOrderForPrimaryInvoice).toHaveBeenCalledWith("OID-1");
    expect(computeGstBreakdown).toHaveBeenCalledWith(1180, "Delhi", "Maharashtra");
    expect(recordPrimaryInvoiceForOrder).toHaveBeenCalledWith("OID-1", {
      invoiceNumber: "TI/2026-27/00001",
      gstRate: 18,
      taxableValue: 1000,
      cgst: 0,
      sgst: 0,
      igst: 180,
      placeOfSupply: "Maharashtra",
      customerGstin: "27AAAAA0000A1Z5",
    });
    expect(createZohoInvoice).not.toHaveBeenCalled();
    expect(releasePrimaryInvoiceClaim).not.toHaveBeenCalled();
  });
});

describe("flag ON — falls back to Zoho on any failure", () => {
  it("missing company state -> releases claim, falls back to Zoho", async () => {
    isPrimaryBillingEnabled.mockReturnValue(true);
    getCompanyProfile.mockReturnValue({ state: "", name: "Co", gstin: "07X" });
    const result = await createPrimaryInvoice(baseCtx());
    expect(result).toEqual({ invoiceId: "zoho-1", invoiceNumber: "ZOHO-1" });
    expect(releasePrimaryInvoiceClaim).toHaveBeenCalledWith("OID-1");
    expect(createZohoInvoice).toHaveBeenCalled();
    expect(recordPrimaryInvoiceForOrder).not.toHaveBeenCalled();
  });

  it("allocateInvoiceNumber throws -> releases claim, falls back to Zoho", async () => {
    isPrimaryBillingEnabled.mockReturnValue(true);
    allocateInvoiceNumber.mockRejectedValue(new Error("counter unreachable"));
    const result = await createPrimaryInvoice(baseCtx());
    expect(result).toEqual({ invoiceId: "zoho-1", invoiceNumber: "ZOHO-1" });
    expect(releasePrimaryInvoiceClaim).toHaveBeenCalledWith("OID-1");
  });

  it("recordPrimaryInvoiceForOrder throws -> releases claim, falls back to Zoho", async () => {
    isPrimaryBillingEnabled.mockReturnValue(true);
    recordPrimaryInvoiceForOrder.mockRejectedValue(new Error("db write failed"));
    const result = await createPrimaryInvoice(baseCtx());
    expect(result).toEqual({ invoiceId: "zoho-1", invoiceNumber: "ZOHO-1" });
    expect(releasePrimaryInvoiceClaim).toHaveBeenCalledWith("OID-1");
  });

  it("even the Zoho fallback throwing propagates (both engines failed)", async () => {
    isPrimaryBillingEnabled.mockReturnValue(true);
    allocateInvoiceNumber.mockRejectedValue(new Error("counter unreachable"));
    createZohoInvoice.mockRejectedValue(new Error("Zoho also down"));
    await expect(createPrimaryInvoice(baseCtx())).rejects.toThrow("Zoho also down");
  });
});
