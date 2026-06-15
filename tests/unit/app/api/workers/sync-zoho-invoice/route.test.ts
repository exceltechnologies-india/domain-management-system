/**
 * Tests for `app/api/workers/sync-zoho-invoice/route.ts` (slice 7i4, part 1).
 *
 * Cloud-Tasks-fired worker: creates a Zoho Books invoice for a paid
 * order, fully decoupled from the payment webhook.
 *
 * Threat model:
 *  - **Double-invoice from parallel retries**: Cloud Tasks may retry
 *    a task while a previous run is still in-flight. Pinned: atomic
 *    claim — if `claimOrderForZohoInvoice` returns null, the worker
 *    returns 200 and Cloud Tasks stops retrying.
 *  - **Permanent-vs-transient response code**: returns 200 (no retry)
 *    for permanent failures (order not found, already-synced); 500
 *    (Cloud Tasks retries) for transient failures (Zoho returned
 *    null, user lookup glitch, outer throw). Pinned per-branch.
 *  - **Invoice metadata correctness**: durationMonths=12 → 'years'
 *    qty=1; otherwise months qty=durationMonths.
 *
 * Other pins:
 *  - cron-secret → 401 if missing
 *  - zod: 9-field strict schema; serviceType enum hosting|domain;
 *    amount nonnegative; durationMonths positive int
 *  - getOrderById null → 200 success:false "skipped"
 *  - zohoInvoiceId already set + not 'pending_creation' → 200
 *    success:true "Already synced" with the existing invoice ID
 *  - claim called with { allowNull: true }
 *  - claim fails → 200 "Already claimed"
 *  - user not found → release claim + 404 USER_NOT_FOUND
 *  - hostingPlan lookup ONLY when serviceType='hosting' AND
 *    hostingPlanId present
 *  - createInvoice called with paymentMode='Razorpay' +
 *    shouldApplyPayment=true
 *  - invoice success → recordZohoInvoiceForOrder + 200 with invoice
 *    ID + number
 *  - invoice null → release claim + 500 ZOHO_NULL_RESPONSE
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const authorizeCronRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cron-auth", () => ({ authorizeCronRequest }));

const getOrderById = vi.hoisted(() => vi.fn());
const claimOrderForZohoInvoice = vi.hoisted(() => vi.fn());
const releaseZohoInvoiceClaim = vi.hoisted(() => vi.fn());
const recordZohoInvoiceForOrder = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  getOrderById,
  claimOrderForZohoInvoice,
  releaseZohoInvoiceClaim,
  recordZohoInvoiceForOrder,
}));

const getUserById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserById }));

const getPlanByPlanId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hosting-plans", () => ({ getPlanByPlanId }));

const createInvoice = vi.hoisted(() => vi.fn());
vi.mock("@/lib/zohobooks", () => ({
  ZohoBooksService: {
    getInstance: () => ({ createInvoice }),
  },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/workers/sync-zoho-invoice/route";

const VALID = {
  orderId: "O1",
  userId: "U1",
  serviceType: "hosting",
  domainName: "example.com",
  hostingPlanId: "starter",
  amount: 999,
  currency: "INR",
  razorpayPaymentId: "pay_abc",
  durationMonths: 12,
};

function makeReq(body: unknown = VALID) {
  return new NextRequest("https://example.com/api/workers/sync-zoho-invoice", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  authorizeCronRequest.mockReset().mockReturnValue(true);
  getOrderById.mockReset();
  claimOrderForZohoInvoice.mockReset();
  releaseZohoInvoiceClaim.mockReset().mockResolvedValue(undefined);
  recordZohoInvoiceForOrder.mockReset().mockResolvedValue(undefined);
  getUserById.mockReset();
  getPlanByPlanId.mockReset();
  createInvoice.mockReset();
});

describe("Auth gate", () => {
  it("no cron-secret → 401; no DB work", async () => {
    authorizeCronRequest.mockReturnValueOnce(false);
    const res = await POST(makeReq());
    expect(res.status).toBe(401);
    expect(getOrderById).not.toHaveBeenCalled();
  });
});

describe("Zod schema", () => {
  it("missing orderId → 400", async () => {
    const body = { ...VALID } as Partial<typeof VALID>;
    delete body.orderId;
    const res = await POST(makeReq(body));
    expect(res.status).toBe(400);
  });

  it("invalid serviceType → 400", async () => {
    const res = await POST(makeReq({ ...VALID, serviceType: "bogus" }));
    expect(res.status).toBe(400);
  });

  it("amount negative → 400", async () => {
    const res = await POST(makeReq({ ...VALID, amount: -1 }));
    expect(res.status).toBe(400);
  });

  it("durationMonths float → 400", async () => {
    const res = await POST(makeReq({ ...VALID, durationMonths: 1.5 }));
    expect(res.status).toBe(400);
  });

  it("durationMonths zero → 400 (positive int)", async () => {
    const res = await POST(makeReq({ ...VALID, durationMonths: 0 }));
    expect(res.status).toBe(400);
  });
});

describe("Permanent-skip paths (200, NOT 500 — no Cloud Tasks retry)", () => {
  it("**order not found → 200 success:false 'skipped' (NOT 500)**", async () => {
    getOrderById.mockResolvedValueOnce(null);
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.message).toContain("skipped");
    expect(claimOrderForZohoInvoice).not.toHaveBeenCalled();
  });

  it("**zohoInvoiceId already set (real ID) → 200 success:true 'Already synced'**", async () => {
    getOrderById.mockResolvedValueOnce({
      _id: "O1",
      zohoInvoiceId: "INV-EXISTING",
    });
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toBe("Already synced");
    expect(body.zohoInvoiceId).toBe("INV-EXISTING");
    expect(claimOrderForZohoInvoice).not.toHaveBeenCalled();
  });

  it("zohoInvoiceId === 'pending_creation' → proceeds (treated as unset)", async () => {
    getOrderById.mockResolvedValueOnce({
      _id: "O1",
      zohoInvoiceId: "pending_creation",
    });
    claimOrderForZohoInvoice.mockResolvedValueOnce({ _id: "O1" });
    getUserById.mockResolvedValueOnce({
      _id: "U1",
      email: "alice@example.com",
    });
    createInvoice.mockResolvedValueOnce({
      invoice_id: "INV-NEW",
      invoice_number: "INV-001",
    });
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(claimOrderForZohoInvoice).toHaveBeenCalledTimes(1);
  });

  it("**atomic claim fails → 200 'Already claimed' (NOT 500)** — anti-double-create", async () => {
    getOrderById.mockResolvedValueOnce({ _id: "O1" });
    claimOrderForZohoInvoice.mockResolvedValueOnce(null);
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe("Already claimed");
    expect(createInvoice).not.toHaveBeenCalled();
  });

  it("claim called with { allowNull: true }", async () => {
    getOrderById.mockResolvedValueOnce({ _id: "O1" });
    claimOrderForZohoInvoice.mockResolvedValueOnce({ _id: "O1" });
    getUserById.mockResolvedValueOnce({ _id: "U1", email: "a@b.com" });
    createInvoice.mockResolvedValueOnce({
      invoice_id: "INV",
      invoice_number: "N1",
    });
    await POST(makeReq());
    expect(claimOrderForZohoInvoice).toHaveBeenCalledWith(
      "O1",
      expect.objectContaining({ allowNull: true })
    );
  });
});

describe("Transient-retry paths (500, Cloud Tasks retries)", () => {
  it("**user not found → release claim + 404 USER_NOT_FOUND (Cloud Tasks will retry)**", async () => {
    getOrderById.mockResolvedValueOnce({ _id: "O1" });
    claimOrderForZohoInvoice.mockResolvedValueOnce({ _id: "O1" });
    getUserById.mockResolvedValueOnce(null);
    const res = await POST(makeReq());
    expect(res.status).toBe(404);
    expect(releaseZohoInvoiceClaim).toHaveBeenCalledWith("O1");
    expect(createInvoice).not.toHaveBeenCalled();
  });

  it("**Zoho returns null → release claim + 500 ZOHO_NULL_RESPONSE**", async () => {
    getOrderById.mockResolvedValueOnce({ _id: "O1" });
    claimOrderForZohoInvoice.mockResolvedValueOnce({ _id: "O1" });
    getUserById.mockResolvedValueOnce({ _id: "U1", email: "a@b.com" });
    createInvoice.mockResolvedValueOnce(null);
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("ZOHO_NULL_RESPONSE");
    expect(releaseZohoInvoiceClaim).toHaveBeenCalledTimes(1);
    expect(recordZohoInvoiceForOrder).not.toHaveBeenCalled();
  });

  it("Zoho returns invoice without invoice_id → treated as null path", async () => {
    getOrderById.mockResolvedValueOnce({ _id: "O1" });
    claimOrderForZohoInvoice.mockResolvedValueOnce({ _id: "O1" });
    getUserById.mockResolvedValueOnce({ _id: "U1", email: "a@b.com" });
    createInvoice.mockResolvedValueOnce({ invoice_id: null });
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    expect(releaseZohoInvoiceClaim).toHaveBeenCalledTimes(1);
  });

  it("outer catch (getOrderById throw) → 500 ZOHO_SYNC_ERROR", async () => {
    getOrderById.mockRejectedValueOnce(new Error("Mongo down"));
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("ZOHO_SYNC_ERROR");
  });
});

describe("Period unit mapping", () => {
  function setupSuccess() {
    getOrderById.mockResolvedValueOnce({ _id: "O1" });
    claimOrderForZohoInvoice.mockResolvedValueOnce({ _id: "O1" });
    getUserById.mockResolvedValueOnce({ _id: "U1", email: "a@b.com" });
    createInvoice.mockResolvedValueOnce({
      invoice_id: "INV",
      invoice_number: "N1",
    });
  }

  it("durationMonths=12 → periodUnit='years', registrationPeriod=1", async () => {
    setupSuccess();
    await POST(makeReq({ ...VALID, durationMonths: 12 }));
    const items = createInvoice.mock.calls[0][2];
    expect(items[0].periodUnit).toBe("years");
    expect(items[0].registrationPeriod).toBe(1);
  });

  it("durationMonths=3 → periodUnit='months', registrationPeriod=3", async () => {
    setupSuccess();
    await POST(makeReq({ ...VALID, durationMonths: 3 }));
    const items = createInvoice.mock.calls[0][2];
    expect(items[0].periodUnit).toBe("months");
    expect(items[0].registrationPeriod).toBe(3);
  });
});

describe("Hosting-plan lookup gate", () => {
  function setupSuccess() {
    getOrderById.mockResolvedValueOnce({ _id: "O1" });
    claimOrderForZohoInvoice.mockResolvedValueOnce({ _id: "O1" });
    getUserById.mockResolvedValueOnce({ _id: "U1", email: "a@b.com" });
    createInvoice.mockResolvedValueOnce({
      invoice_id: "INV",
      invoice_number: "N1",
    });
  }

  it("serviceType='hosting' + hostingPlanId → getPlanByPlanId called", async () => {
    setupSuccess();
    getPlanByPlanId.mockResolvedValueOnce({ planId: "starter" });
    await POST(makeReq(VALID));
    expect(getPlanByPlanId).toHaveBeenCalledWith("starter");
    const items = createInvoice.mock.calls[0][2];
    expect(items[0].hostingPlan).toEqual(
      expect.objectContaining({ planId: "starter" })
    );
  });

  it("serviceType='domain' → getPlanByPlanId NOT called; hostingPlan undefined", async () => {
    setupSuccess();
    await POST(makeReq({ ...VALID, serviceType: "domain" }));
    expect(getPlanByPlanId).not.toHaveBeenCalled();
    const items = createInvoice.mock.calls[0][2];
    expect(items[0].hostingPlan).toBeUndefined();
  });

  it("serviceType='hosting' + NO hostingPlanId → getPlanByPlanId NOT called", async () => {
    setupSuccess();
    const body = { ...VALID } as Record<string, unknown>;
    delete body.hostingPlanId;
    await POST(makeReq(body));
    expect(getPlanByPlanId).not.toHaveBeenCalled();
  });
});

describe("Invoice creation parameters", () => {
  it("createInvoice called with paymentMode='Razorpay' + shouldApplyPayment=true", async () => {
    getOrderById.mockResolvedValueOnce({ _id: "O1" });
    claimOrderForZohoInvoice.mockResolvedValueOnce({ _id: "O1" });
    getUserById.mockResolvedValueOnce({ _id: "U1", email: "a@b.com" });
    createInvoice.mockResolvedValueOnce({
      invoice_id: "INV",
      invoice_number: "N1",
    });
    await POST(makeReq());
    expect(createInvoice).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.any(Array),
      "Razorpay",
      true
    );
  });
});

describe("Happy path", () => {
  it("invoice success → recordZohoInvoiceForOrder + 200 with IDs", async () => {
    getOrderById.mockResolvedValueOnce({ _id: "O1" });
    claimOrderForZohoInvoice.mockResolvedValueOnce({ _id: "O1" });
    getUserById.mockResolvedValueOnce({ _id: "U1", email: "a@b.com" });
    createInvoice.mockResolvedValueOnce({
      invoice_id: "INV-NEW",
      invoice_number: "INV-001",
    });
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(
      expect.objectContaining({
        success: true,
        zohoInvoiceId: "INV-NEW",
        invoiceNumber: "INV-001",
      })
    );
    expect(recordZohoInvoiceForOrder).toHaveBeenCalledWith(
      "O1",
      expect.objectContaining({
        invoiceId: "INV-NEW",
        invoiceNumber: "INV-001",
      })
    );
  });
});
