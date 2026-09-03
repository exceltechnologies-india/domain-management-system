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

const isZohoInvoiceFallbackEnabled = vi.hoisted(() => vi.fn());
vi.mock("@/lib/zoho-fallback-flag", () => ({ isZohoInvoiceFallbackEnabled }));

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

// Hoisted so the fallback-disabled tests can assert on the ERROR text — the
// loud "left UNINVOICED" line IS the deliverable of that branch.
const serverLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/lib/server-logger", () => ({ serverLogger }));

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
  // Fallback defaults ON, matching production.
  isZohoInvoiceFallbackEnabled.mockReset().mockReturnValue(true);
  serverLogger.error.mockReset();
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

// The primary engine is PERMANENT as of 2026-09-03 — the old
// PRIMARY_BILLING_ENABLED gate was removed, so there is deliberately no
// configuration that bypasses it. These pin that there is no way back to
// "Zoho issues the invoice directly".
describe("primary engine is ungated", () => {
  it("**always runs the primary engine, whatever the fallback flag says**", async () => {
    isZohoInvoiceFallbackEnabled.mockReturnValue(false);
    const result = await createPrimaryInvoice(baseCtx());
    expect(result.provider).toBe("primary");
    expect(claimOrderForPrimaryInvoice).toHaveBeenCalled();
    expect(allocateInvoiceNumber).toHaveBeenCalled();
    expect(createZohoInvoice).not.toHaveBeenCalled();
  });

  it("the fallback flag is not even consulted on the happy path — it only governs failure", async () => {
    await createPrimaryInvoice(baseCtx());
    expect(isZohoInvoiceFallbackEnabled).not.toHaveBeenCalled();
  });
});

describe("zero-amount / trial skip (applies before either engine)", () => {
  it("amount <= 0 -> skipped silently, Zoho never called", async () => {
    const result = await createPrimaryInvoice(baseCtx({ order: { ...order, amount: 0 } }));
    expect(result).toEqual({ invoiceId: "", invoiceNumber: null, provider: "skipped" });
    expect(createZohoInvoice).not.toHaveBeenCalled();
    expect(claimOrderForPrimaryInvoice).not.toHaveBeenCalled();
  });

  it("orderType hosting_trial -> skipped silently", async () => {
    const result = await createPrimaryInvoice(
      baseCtx({ order: { ...order, orderType: "hosting_trial" } })
    );
    expect(result).toEqual({ invoiceId: "", invoiceNumber: null, provider: "skipped" });
    expect(createZohoInvoice).not.toHaveBeenCalled();
  });
});

describe("claim contention", () => {
  it("claim fails (already claimed/issued) -> silent skip, NOT a Zoho fallback", async () => {
    claimOrderForPrimaryInvoice.mockResolvedValue(false);
    const result = await createPrimaryInvoice(baseCtx());
    expect(result).toEqual({ invoiceId: "", invoiceNumber: null, provider: "skipped" });
    expect(createZohoInvoice).not.toHaveBeenCalled();
    expect(allocateInvoiceNumber).not.toHaveBeenCalled();
  });
});

describe("happy path", () => {
  it("computes breakdown, allocates a number, records it, and never calls Zoho", async () => {
    const result = await createPrimaryInvoice(baseCtx());
    expect(result).toEqual({
      invoiceId: "TI/2026-27/00001",
      invoiceNumber: "TI/2026-27/00001",
      provider: "primary",
    });
    expect(claimOrderForPrimaryInvoice).toHaveBeenCalledWith("OID-1", undefined);
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

describe("claimOptions forwarding (Phase 1c audit, 2026-09-03)", () => {
  it("**forwards claimOptions to the PRIMARY claim too**, not just to the Zoho fallback — the async sync-zoho-invoice worker needs stale-claim recovery on both engines", async () => {
    const claimOptions = { allowNull: true, staleClaimAfterMs: 5 * 60 * 1000 };
    await createPrimaryInvoice(baseCtx(), { claimOptions });
    expect(claimOrderForPrimaryInvoice).toHaveBeenCalledWith(
      "OID-1",
      expect.objectContaining({ staleClaimAfterMs: 5 * 60 * 1000 })
    );
  });

  it("synchronous callers (no claimOptions) still get the strict no-stealing default", async () => {
    await createPrimaryInvoice(baseCtx());
    const opts = claimOrderForPrimaryInvoice.mock.calls[0][1];
    expect(opts?.staleClaimAfterMs).toBeUndefined();
  });

  it("claimOptions still reach the Zoho fallback when the primary engine fails", async () => {
    getCompanyProfile.mockReturnValue({ state: "", name: "Co", gstin: "07X" });
    const claimOptions = { allowNull: true, staleClaimAfterMs: 5 * 60 * 1000 };
    await createPrimaryInvoice(baseCtx(), { claimOptions });
    expect(createZohoInvoice).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ claimOptions })
    );
  });
});

describe("falls back to Zoho on any failure (fallback ON, the default)", () => {
  it("missing company state -> releases claim, falls back to Zoho", async () => {
    getCompanyProfile.mockReturnValue({ state: "", name: "Co", gstin: "07X" });
    const result = await createPrimaryInvoice(baseCtx());
    expect(result).toEqual({ invoiceId: "zoho-1", invoiceNumber: "ZOHO-1", provider: "zoho" });
    expect(releasePrimaryInvoiceClaim).toHaveBeenCalledWith("OID-1");
    expect(createZohoInvoice).toHaveBeenCalled();
    expect(recordPrimaryInvoiceForOrder).not.toHaveBeenCalled();
  });

  it("allocateInvoiceNumber throws -> releases claim, falls back to Zoho", async () => {
    allocateInvoiceNumber.mockRejectedValue(new Error("counter unreachable"));
    const result = await createPrimaryInvoice(baseCtx());
    expect(result).toEqual({ invoiceId: "zoho-1", invoiceNumber: "ZOHO-1", provider: "zoho" });
    expect(releasePrimaryInvoiceClaim).toHaveBeenCalledWith("OID-1");
  });

  it("recordPrimaryInvoiceForOrder throws -> releases claim, falls back to Zoho", async () => {
    recordPrimaryInvoiceForOrder.mockRejectedValue(new Error("db write failed"));
    const result = await createPrimaryInvoice(baseCtx());
    expect(result).toEqual({ invoiceId: "zoho-1", invoiceNumber: "ZOHO-1", provider: "zoho" });
    expect(releasePrimaryInvoiceClaim).toHaveBeenCalledWith("OID-1");
  });

  it("even the Zoho fallback throwing propagates (both engines failed)", async () => {
    allocateInvoiceNumber.mockRejectedValue(new Error("counter unreachable"));
    createZohoInvoice.mockRejectedValue(new Error("Zoho also down"));
    await expect(createPrimaryInvoice(baseCtx())).rejects.toThrow("Zoho also down");
  });
});

describe("fallback DISABLED — failures surface instead of being papered over", () => {
  beforeEach(() => {
    isZohoInvoiceFallbackEnabled.mockReturnValue(false);
  });

  it("**rethrows instead of issuing a Zoho invoice**, so the caller records it and the order shows up in integration-health", async () => {
    getCompanyProfile.mockReturnValue({ state: "", name: "Co", gstin: "07X" });
    await expect(createPrimaryInvoice(baseCtx())).rejects.toThrow(
      /ZOHO_ORG_STATE is not configured/
    );
    expect(createZohoInvoice).not.toHaveBeenCalled();
  });

  it("still releases the primary claim before rethrowing — a retry must not be blocked by the failed attempt", async () => {
    getCompanyProfile.mockReturnValue({ state: "", name: "Co", gstin: "07X" });
    await expect(createPrimaryInvoice(baseCtx())).rejects.toThrow();
    expect(releasePrimaryInvoiceClaim).toHaveBeenCalledWith("OID-1");
  });

  it("preserves the ORIGINAL error, not a wrapped one — the caller logs the real reason", async () => {
    allocateInvoiceNumber.mockRejectedValueOnce(new Error("Counter shard timeout"));
    await expect(createPrimaryInvoice(baseCtx())).rejects.toThrow("Counter shard timeout");
  });

  it("logs the uninvoiced consequence explicitly, naming the flag", async () => {
    getCompanyProfile.mockReturnValue({ state: "", name: "Co", gstin: "07X" });
    await expect(createPrimaryInvoice(baseCtx())).rejects.toThrow();
    const logged = serverLogger.error.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("ZOHO_INVOICE_FALLBACK_ENABLED");
    expect(logged).toContain("UNINVOICED");
  });

  it("**does NOT affect the happy path** — a working primary engine is unchanged with the fallback off", async () => {
    const result = await createPrimaryInvoice(baseCtx());
    expect(result.provider).toBe("primary");
    expect(createZohoInvoice).not.toHaveBeenCalled();
  });

  it("does NOT affect the zero-amount/trial skip — still a silent no-op, not a throw", async () => {
    const result = await createPrimaryInvoice(
      baseCtx({ order: { ...order, amount: 0 } })
    );
    expect(result).toEqual({ invoiceId: "", invoiceNumber: null, provider: "skipped" });
  });

  it("does NOT affect claim contention — a concurrent claim is still a silent skip, not a throw", async () => {
    claimOrderForPrimaryInvoice.mockResolvedValue(false);
    const result = await createPrimaryInvoice(baseCtx());
    expect(result).toEqual({ invoiceId: "", invoiceNumber: null, provider: "skipped" });
    expect(createZohoInvoice).not.toHaveBeenCalled();
  });
});
