/**
 * Tests for `@/lib/services/billing/createPrimaryInvoice` — the single invoice
 * chokepoint. Our own GST engine is the only issuer: Zoho Books was the
 * fallback until it was removed on 24 Sep 2026 by owner decision, so a failure
 * now THROWS and the caller records it (`markInvoiceCreationFailed`).
 *
 * Every collaborator is mocked so this suite pins the DECISION LOGIC only
 * (zero-amount/trial skip, claim, throw-on-failure) — the GST math and
 * numbering atomicity are covered by tests/unit/lib/billing/gst.test.ts and
 * tests/integration/lib/billing/invoiceNumber.test.ts.
 *
 * Pins:
 *  - zero-amount / hosting_trial order -> skipped before any claim
 *  - claim fails (concurrent request already handling it / already issued)
 *    -> silent skip, never a throw and never a second number
 *  - happy path -> gst breakdown computed, number allocated, recorded
 *  - ANY throw (missing COMPANY_STATE, allocation failure, record failure)
 *    -> claim released, ORIGINAL error rethrown, nothing else issued
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IOrder } from "@/models/Order";
import type { IUser } from "@/models/User";
import type { InvoiceContext } from "@/lib/services/payment/post-tasks";

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

// Hoisted so the failure tests can assert on the ERROR text — the loud
// "UNINVOICED" line is part of the deliverable of that branch.
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
};

const user = {
  _id: "U1",
  address: { state: "Maharashtra" },
  gstNumber: "27AAAAA0000A1Z5",
};

function baseCtx(overrides: { order?: Record<string, unknown> } = {}): InvoiceContext {
  return {
    order: (overrides.order ?? order) as unknown as IOrder,
    orderId: "ORD-1",
    razorpay_payment_id: "pay_1",
    paymentDetails: { id: "pay_1", amount: 1180, currency: "INR" } as unknown as InvoiceContext["paymentDetails"],
    user: user as unknown as IUser,
    cartItems: [],
  };
}

beforeEach(() => {
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
});

describe("zero-amount / trial skip (applies before any claim)", () => {
  it("amount <= 0 -> skipped silently, nothing claimed or allocated", async () => {
    const result = await createPrimaryInvoice(baseCtx({ order: { ...order, amount: 0 } }));
    expect(result).toEqual({ invoiceId: "", invoiceNumber: null, provider: "skipped" });
    expect(claimOrderForPrimaryInvoice).not.toHaveBeenCalled();
    expect(allocateInvoiceNumber).not.toHaveBeenCalled();
  });

  it("orderType hosting_trial -> skipped silently even with a positive amount", async () => {
    const result = await createPrimaryInvoice(
      baseCtx({ order: { ...order, orderType: "hosting_trial" } })
    );
    expect(result).toEqual({ invoiceId: "", invoiceNumber: null, provider: "skipped" });
    expect(claimOrderForPrimaryInvoice).not.toHaveBeenCalled();
    expect(allocateInvoiceNumber).not.toHaveBeenCalled();
  });
});

describe("claim contention — the double-billing guard", () => {
  it("claim fails (already claimed/issued) -> silent skip, no number allocated, no throw", async () => {
    claimOrderForPrimaryInvoice.mockResolvedValue(false);
    const result = await createPrimaryInvoice(baseCtx());
    expect(result).toEqual({ invoiceId: "", invoiceNumber: null, provider: "skipped" });
    expect(allocateInvoiceNumber).not.toHaveBeenCalled();
    expect(recordPrimaryInvoiceForOrder).not.toHaveBeenCalled();
    // A skip must not release someone else's claim.
    expect(releasePrimaryInvoiceClaim).not.toHaveBeenCalled();
  });
});

describe("happy path", () => {
  it("computes breakdown, allocates a number, records it", async () => {
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
    expect(allocateInvoiceNumber).toHaveBeenCalledTimes(1);
    expect(releasePrimaryInvoiceClaim).not.toHaveBeenCalled();
  });
});

describe("claimOptions forwarding", () => {
  it("forwards claimOptions to the claim — async retried callers need stale-claim recovery", async () => {
    await createPrimaryInvoice(baseCtx(), { claimOptions: { staleClaimAfterMs: 5 * 60 * 1000 } });
    expect(claimOrderForPrimaryInvoice).toHaveBeenCalledWith("OID-1", {
      staleClaimAfterMs: 5 * 60 * 1000,
    });
  });

  it("synchronous callers (no claimOptions) still get the strict no-stealing default", async () => {
    await createPrimaryInvoice(baseCtx());
    const opts = claimOrderForPrimaryInvoice.mock.calls[0][1];
    expect(opts?.staleClaimAfterMs).toBeUndefined();
  });
});

describe("failure throws — there is no fallback engine", () => {
  it("missing COMPANY_STATE -> throws naming the env var, releases claim, nothing recorded", async () => {
    getCompanyProfile.mockReturnValue({ state: "", name: "Co", gstin: "07X" });
    await expect(createPrimaryInvoice(baseCtx())).rejects.toThrow(
      /COMPANY_STATE is not configured/
    );
    expect(releasePrimaryInvoiceClaim).toHaveBeenCalledWith("OID-1");
    expect(allocateInvoiceNumber).not.toHaveBeenCalled();
    expect(recordPrimaryInvoiceForOrder).not.toHaveBeenCalled();
  });

  it("allocateInvoiceNumber throws -> original error rethrown, claim released", async () => {
    allocateInvoiceNumber.mockRejectedValue(new Error("counter unreachable"));
    await expect(createPrimaryInvoice(baseCtx())).rejects.toThrow("counter unreachable");
    expect(releasePrimaryInvoiceClaim).toHaveBeenCalledWith("OID-1");
    expect(recordPrimaryInvoiceForOrder).not.toHaveBeenCalled();
  });

  it("recordPrimaryInvoiceForOrder throws -> original error rethrown, claim released", async () => {
    recordPrimaryInvoiceForOrder.mockRejectedValue(new Error("db write failed"));
    await expect(createPrimaryInvoice(baseCtx())).rejects.toThrow("db write failed");
    expect(releasePrimaryInvoiceClaim).toHaveBeenCalledWith("OID-1");
    // One attempt, one number — a failure does not retry into a second allocation.
    expect(allocateInvoiceNumber).toHaveBeenCalledTimes(1);
  });

  it("preserves the ORIGINAL error object, not a wrapped one — the caller logs the real reason", async () => {
    const original = new Error("Counter shard timeout");
    allocateInvoiceNumber.mockRejectedValueOnce(original);
    await expect(createPrimaryInvoice(baseCtx())).rejects.toBe(original);
  });

  it("logs the uninvoiced consequence explicitly, naming the order", async () => {
    getCompanyProfile.mockReturnValue({ state: "", name: "Co", gstin: "07X" });
    await expect(createPrimaryInvoice(baseCtx())).rejects.toThrow();
    const logged = serverLogger.error.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("UNINVOICED");
    expect(logged).toContain("ORD-1");
  });
});
