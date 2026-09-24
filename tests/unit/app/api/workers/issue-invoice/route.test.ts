/**
 * Tests for `app/api/workers/issue-invoice/route.ts` (was
 * `/workers/sync-zoho-invoice` until Zoho Books was removed on 24 Sep 2026).
 *
 * Cloud-Tasks-fired worker: issues the invoice for a paid mandate/autopay
 * renewal, fully decoupled from the payment webhook, through the shared
 * `createPrimaryInvoice` chokepoint.
 *
 * Threat model:
 *  - **Silent invoice loss from double-claiming**: the engine behind the
 *    chokepoint claims internally, so a claim here too would make the inner
 *    claim see this worker's own lease, skip, and return an empty result —
 *    200 success with NO invoice issued. Pinned: the worker takes NO claim
 *    of its own.
 *  - **Double-invoice from parallel retries**: handled by the chokepoint's
 *    own claim. A `provider: 'skipped'` result means somebody else holds it
 *    → 200, Cloud Tasks stops.
 *  - **Permanently stranded claim**: an async, queue-retried caller must be
 *    able to steal a claim stranded by a crashed attempt. Pinned:
 *    `staleClaimAfterMs` (and ONLY that) is passed.
 *  - **Double-billing an already-invoiced order**: ANY `invoiceProvider` —
 *    'primary', or a historical 'zoho' — means the payment already has a tax
 *    invoice. Pinned: 200 and the chokepoint is never called, for both.
 *  - **Permanent-vs-transient response code**: 200 (no retry) for permanent
 *    outcomes (order not found, already invoiced, skipped); 500
 *    INVOICE_ISSUE_ERROR (Cloud Tasks retries) when the engine failed — and
 *    the order is flagged via markInvoiceCreationFailed FIRST, so it stays
 *    visible even if every retry fails.
 *  - **Invoice metadata correctness**: durationMonths=12 → 'years' qty=1;
 *    otherwise months qty=durationMonths.
 *
 * Other pins:
 *  - cron-secret → 401 if missing
 *  - zod: 9-field schema; serviceType enum hosting|domain;
 *    amount nonnegative; durationMonths positive int
 *  - getOrderById null → 200 success:false "skipped"
 *  - user not found → 404 USER_NOT_FOUND
 *  - hostingPlan lookup ONLY when serviceType='hosting' AND hostingPlanId
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const authorizeCronRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cron-auth", () => ({ authorizeCronRequest }));

const getOrderById = vi.hoisted(() => vi.fn());
const markInvoiceCreationFailed = vi.hoisted(() => vi.fn());
// The primary claim helper is exported by the mock ON PURPOSE even though the
// worker must not import it: that turns "the worker took a claim of its own
// again" into a failing assertion below rather than an inscrutable TypeError
// from an undefined import.
const claimOrderForPrimaryInvoice = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  getOrderById,
  markInvoiceCreationFailed,
  claimOrderForPrimaryInvoice,
}));

const getUserById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserById }));

const getPlanByPlanId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hosting-plans", () => ({ getPlanByPlanId }));

// The chokepoint is mocked at the module boundary: it owns the claim and has
// its own test suite. Mocking it also keeps this file from transitively
// importing post-tasks -> lib/email, which throws without SMTP env configured.
const createPrimaryInvoice = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/billing/createPrimaryInvoice", () => ({
  createPrimaryInvoice,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/workers/issue-invoice/route";

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
  return new NextRequest("https://example.com/api/workers/issue-invoice", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    _id: "O1",
    orderId: "ORD-RNW-1",
    amount: 999,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  };
}

/** Wires the mocks for a run that reaches the chokepoint and succeeds. */
function setupSuccess() {
  getOrderById.mockResolvedValueOnce(orderRow());
  getUserById.mockResolvedValueOnce({ _id: "U1", email: "a@b.com" });
  createPrimaryInvoice.mockResolvedValueOnce({
    invoiceId: "TI/2026-27/00001",
    invoiceNumber: "TI/2026-27/00001",
    provider: "primary",
  });
}

/** The cartItems array handed to the chokepoint on the last call. */
function itemsFromLastCall() {
  return createPrimaryInvoice.mock.calls[0][0].cartItems;
}

beforeEach(() => {
  authorizeCronRequest.mockReset().mockReturnValue(true);
  getOrderById.mockReset();
  markInvoiceCreationFailed.mockReset().mockResolvedValue(undefined);
  claimOrderForPrimaryInvoice.mockReset().mockResolvedValue(true);
  getUserById.mockReset();
  getPlanByPlanId.mockReset();
  createPrimaryInvoice.mockReset();
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

describe("Chokepoint wiring", () => {
  it("**issues via createPrimaryInvoice**", async () => {
    setupSuccess();
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(createPrimaryInvoice).toHaveBeenCalledTimes(1);
  });

  it("**takes NO claim of its own** — the engine claims internally, so a second lease here would make the inner claim skip and silently issue nothing", async () => {
    setupSuccess();
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(claimOrderForPrimaryInvoice).not.toHaveBeenCalled();
  });

  it("no claim is taken on ANY exit path — including the 404 and 500 branches", async () => {
    // user-missing branch
    getOrderById.mockResolvedValueOnce(orderRow());
    getUserById.mockResolvedValueOnce(null);
    await POST(makeReq());
    // engine-failed branch
    getOrderById.mockResolvedValueOnce(orderRow());
    getUserById.mockResolvedValueOnce({ _id: "U1", email: "a@b.com" });
    createPrimaryInvoice.mockRejectedValueOnce(new Error("boom"));
    await POST(makeReq());

    expect(claimOrderForPrimaryInvoice).not.toHaveBeenCalled();
  });

  it("**claimOptions is exactly { staleClaimAfterMs: 5 min }** — async, queue-retried caller must be able to steal a claim stranded by a crashed prior attempt; the Zoho-era `allowNull` is gone", async () => {
    setupSuccess();
    await POST(makeReq());
    expect(createPrimaryInvoice.mock.calls[0][1]).toEqual({
      claimOptions: { staleClaimAfterMs: 5 * 60 * 1000 },
    });
  });

  it("builds the context from the loaded order + user, not the request payload alone", async () => {
    setupSuccess();
    await POST(makeReq());
    const ctx = createPrimaryInvoice.mock.calls[0][0];
    // orderId must be the user-facing Order.orderId, not the _id from the
    // Cloud Tasks payload.
    expect(ctx.orderId).toBe("ORD-RNW-1");
    expect(ctx.order).toEqual(expect.objectContaining({ _id: "O1" }));
    expect(ctx.user).toEqual(expect.objectContaining({ _id: "U1" }));
    expect(ctx.razorpay_payment_id).toBe("pay_abc");
    expect(ctx.paymentDetails).toEqual(
      expect.objectContaining({
        id: "pay_abc",
        amount: 999,
        currency: "INR",
      })
    );
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
    expect(createPrimaryInvoice).not.toHaveBeenCalled();
  });

  it.each([
    ["primary", "TI/2026-27/00001"],
    ["zoho", "INV-000123"],
  ])(
    "**invoiceProvider '%s' → 200 'Already invoiced', chokepoint never called** — anti-double-billing",
    async (provider, invoiceNumber) => {
      getOrderById.mockResolvedValueOnce(orderRow({ invoiceProvider: provider, invoiceNumber }));
      const res = await POST(makeReq());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.message).toBe("Already invoiced");
      expect(body.provider).toBe(provider);
      expect(body.invoiceNumber).toBe(invoiceNumber);
      expect(createPrimaryInvoice).not.toHaveBeenCalled();
      expect(getUserById).not.toHaveBeenCalled();
      expect(markInvoiceCreationFailed).not.toHaveBeenCalled();
    }
  );

  it("a previously FAILED order (invoiceFailedAt, no provider) is retried, not skipped", async () => {
    getOrderById.mockResolvedValueOnce(
      orderRow({ invoiceFailedAt: new Date("2026-09-20T00:00:00Z") })
    );
    getUserById.mockResolvedValueOnce({ _id: "U1", email: "a@b.com" });
    createPrimaryInvoice.mockResolvedValueOnce({
      invoiceId: "",
      invoiceNumber: "TI/2026-27/00002",
      provider: "primary",
    });
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(createPrimaryInvoice).toHaveBeenCalledTimes(1);
  });

  it("**provider 'skipped' → 200 (NOT 500)** — a concurrent request holds the claim, or the order is zero-amount/trial; retrying can't help", async () => {
    getOrderById.mockResolvedValueOnce(orderRow());
    getUserById.mockResolvedValueOnce({ _id: "U1", email: "a@b.com" });
    createPrimaryInvoice.mockResolvedValueOnce({
      invoiceId: "",
      invoiceNumber: null,
      provider: "skipped",
    });
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.provider).toBe("skipped");
    expect(markInvoiceCreationFailed).not.toHaveBeenCalled();
  });
});

describe("Transient-retry paths (Cloud Tasks retries)", () => {
  it("user not found → 404 USER_NOT_FOUND; chokepoint never called", async () => {
    getOrderById.mockResolvedValueOnce(orderRow());
    getUserById.mockResolvedValueOnce(null);
    const res = await POST(makeReq());
    expect(res.status).toBe(404);
    expect(createPrimaryInvoice).not.toHaveBeenCalled();
  });

  it("**engine throws → order flagged via markInvoiceCreationFailed(order._id, message), then 500 INVOICE_ISSUE_ERROR**", async () => {
    getOrderById.mockResolvedValueOnce(orderRow());
    getUserById.mockResolvedValueOnce({ _id: "U1", email: "a@b.com" });
    createPrimaryInvoice.mockRejectedValueOnce(new Error("COMPANY_STATE is not configured"));
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INVOICE_ISSUE_ERROR");
    expect(markInvoiceCreationFailed).toHaveBeenCalledWith(
      "O1",
      "COMPANY_STATE is not configured"
    );
  });

  it("the flag write failing too still returns 500 (Cloud Tasks retries), not a false 200", async () => {
    getOrderById.mockResolvedValueOnce(orderRow());
    getUserById.mockResolvedValueOnce({ _id: "U1", email: "a@b.com" });
    createPrimaryInvoice.mockRejectedValueOnce(new Error("boom"));
    markInvoiceCreationFailed.mockRejectedValueOnce(new Error("db down"));
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INVOICE_ISSUE_ERROR");
  });

  it("outer catch (getOrderById throw) → 500 INVOICE_ISSUE_ERROR", async () => {
    getOrderById.mockRejectedValueOnce(new Error("Mongo down"));
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INVOICE_ISSUE_ERROR");
  });
});

describe("Response shape", () => {
  it("primary → provider:'primary', TI number, no zohoInvoiceId", async () => {
    setupSuccess();
    const res = await POST(makeReq());
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.provider).toBe("primary");
    expect(body.invoiceNumber).toBe("TI/2026-27/00001");
    expect(body).not.toHaveProperty("zohoInvoiceId");
  });
});

describe("Period unit mapping", () => {
  it("durationMonths=12 → periodUnit='years', registrationPeriod=1", async () => {
    setupSuccess();
    await POST(makeReq({ ...VALID, durationMonths: 12 }));
    const items = itemsFromLastCall();
    expect(items[0].periodUnit).toBe("years");
    expect(items[0].registrationPeriod).toBe(1);
  });

  it("durationMonths=3 → periodUnit='months', registrationPeriod=3", async () => {
    setupSuccess();
    await POST(makeReq({ ...VALID, durationMonths: 3 }));
    const items = itemsFromLastCall();
    expect(items[0].periodUnit).toBe("months");
    expect(items[0].registrationPeriod).toBe(3);
  });

  it("periodUnit is always set explicitly so the chokepoint's inferPeriodUnit pass-through can't rewrite it", async () => {
    setupSuccess();
    await POST(makeReq({ ...VALID, serviceType: "hosting", durationMonths: 3 }));
    const items = itemsFromLastCall();
    expect(items[0].periodUnit).toBeDefined();
  });
});

describe("Hosting-plan lookup gate", () => {
  it("serviceType='hosting' + hostingPlanId → getPlanByPlanId called", async () => {
    setupSuccess();
    getPlanByPlanId.mockResolvedValueOnce({ planId: "starter" });
    await POST(makeReq(VALID));
    expect(getPlanByPlanId).toHaveBeenCalledWith("starter");
    const items = itemsFromLastCall();
    expect(items[0].hostingPlan).toEqual(
      expect.objectContaining({ planId: "starter" })
    );
  });

  it("serviceType='domain' → getPlanByPlanId NOT called; hostingPlan undefined", async () => {
    setupSuccess();
    await POST(makeReq({ ...VALID, serviceType: "domain" }));
    expect(getPlanByPlanId).not.toHaveBeenCalled();
    const items = itemsFromLastCall();
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
