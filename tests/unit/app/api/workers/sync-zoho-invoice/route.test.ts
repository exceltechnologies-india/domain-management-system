/**
 * Tests for `app/api/workers/sync-zoho-invoice/route.ts` (slice 7i4, part 1;
 * rewritten for the Phase 1c audit when the worker moved onto the shared
 * `createPrimaryInvoice` chokepoint).
 *
 * Cloud-Tasks-fired worker: issues the invoice for a paid mandate/autopay
 * renewal, fully decoupled from the payment webhook.
 *
 * Threat model:
 *  - **Silent invoice loss from double-claiming**: the worker used to take
 *    its own `claimOrderForZohoInvoice` lease and then call Zoho directly.
 *    Both engines behind the chokepoint claim internally, so a claim here
 *    too would make the inner claim see this worker's own sentinel, skip,
 *    and return an empty result — 200 success with NO invoice issued.
 *    Pinned: the worker takes NO claim of its own.
 *  - **Double-invoice from parallel retries**: still handled, but now by the
 *    chokepoint's own claim. A `provider: 'skipped'` result means somebody
 *    else holds it → 200, Cloud Tasks stops.
 *  - **Permanently stranded claim**: this is the first ASYNC, queue-retried
 *    caller of the chokepoint, so a crash mid-flight must not lock the order
 *    out forever. Pinned: `staleClaimAfterMs` is passed.
 *  - **Flag flip-flop double-billing**: an order already carrying a primary
 *    TI/... invoice has no `zohoInvoiceId`; with the flag later OFF a retry
 *    would go down the Zoho path and issue a second tax invoice under the
 *    same GSTIN. Pinned: explicit `invoiceProvider === 'primary'` pre-check.
 *  - **Permanent-vs-transient response code**: 200 (no retry) for permanent
 *    outcomes (order not found, already invoiced by either engine, skipped);
 *    500 (Cloud Tasks retries) when both engines failed. Pinned per-branch.
 *  - **Invoice metadata correctness**: durationMonths=12 → 'years' qty=1;
 *    otherwise months qty=durationMonths.
 *
 * Other pins:
 *  - cron-secret → 401 if missing
 *  - zod: 9-field strict schema; serviceType enum hosting|domain;
 *    amount nonnegative; durationMonths positive int
 *  - getOrderById null → 200 success:false "skipped"
 *  - zohoInvoiceId already set + not 'pending_creation' → 200 "Already synced"
 *  - user not found → 404 USER_NOT_FOUND (pre-existing behaviour)
 *  - hostingPlan lookup ONLY when serviceType='hosting' AND hostingPlanId
 *  - `allowNull: true` preserved from the pre-chokepoint implementation
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const authorizeCronRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cron-auth", () => ({ authorizeCronRequest }));

const getOrderById = vi.hoisted(() => vi.fn());
// The claim helpers are exported by the mock ON PURPOSE even though the
// worker must no longer import them: that turns "the worker took a claim of
// its own again" into a failing assertion below rather than an inscrutable
// TypeError from an undefined import.
const claimOrderForZohoInvoice = vi.hoisted(() => vi.fn());
const releaseZohoInvoiceClaim = vi.hoisted(() => vi.fn());
const recordZohoInvoiceForOrder = vi.hoisted(() => vi.fn());
const claimOrderForPrimaryInvoice = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  getOrderById,
  claimOrderForZohoInvoice,
  releaseZohoInvoiceClaim,
  recordZohoInvoiceForOrder,
  claimOrderForPrimaryInvoice,
}));

const getUserById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserById }));

const getPlanByPlanId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hosting-plans", () => ({ getPlanByPlanId }));

// The chokepoint is mocked at the module boundary: it owns the claim, the
// engine choice and the Zoho fallback, and has its own test suite. Mocking it
// also keeps this file from transitively importing post-tasks -> lib/email,
// which throws without SMTP env configured.
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
function setupSuccess(provider: "primary" | "zoho" = "zoho") {
  getOrderById.mockResolvedValueOnce(orderRow());
  getUserById.mockResolvedValueOnce({ _id: "U1", email: "a@b.com" });
  createPrimaryInvoice.mockResolvedValueOnce({
    invoiceId: provider === "zoho" ? "INV-NEW" : "TI/2026-27/00001",
    invoiceNumber: provider === "zoho" ? "INV-001" : "TI/2026-27/00001",
    provider,
  });
}

/** The cartItems array handed to the chokepoint on the last call. */
function itemsFromLastCall() {
  return createPrimaryInvoice.mock.calls[0][0].cartItems;
}

beforeEach(() => {
  authorizeCronRequest.mockReset().mockReturnValue(true);
  getOrderById.mockReset();
  claimOrderForZohoInvoice.mockReset().mockResolvedValue({ _id: "O1" });
  releaseZohoInvoiceClaim.mockReset().mockResolvedValue(undefined);
  recordZohoInvoiceForOrder.mockReset().mockResolvedValue(undefined);
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

describe("Chokepoint wiring (the point of this batch)", () => {
  it("**issues via createPrimaryInvoice, NOT a direct Zoho call**", async () => {
    setupSuccess();
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(createPrimaryInvoice).toHaveBeenCalledTimes(1);
  });

  it("**takes NO claim of its own** — the chokepoint's engines each claim internally, so a second lease here would make the inner claim skip and silently issue nothing", async () => {
    setupSuccess();
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    // Every claim helper stays untouched: the ONLY lease on this order is the
    // one the chokepoint takes internally. Re-introducing a claim here is the
    // regression this pins.
    expect(claimOrderForZohoInvoice).not.toHaveBeenCalled();
    expect(claimOrderForPrimaryInvoice).not.toHaveBeenCalled();
    expect(releaseZohoInvoiceClaim).not.toHaveBeenCalled();
    // Recording the result is the chokepoint's job too.
    expect(recordZohoInvoiceForOrder).not.toHaveBeenCalled();
  });

  it("no claim is taken on ANY exit path — including the 404 and 500 branches, so a failed run leaves no lease behind for Cloud Tasks to trip over", async () => {
    // user-missing branch
    getOrderById.mockResolvedValueOnce(orderRow());
    getUserById.mockResolvedValueOnce(null);
    await POST(makeReq());
    // both-engines-failed branch
    getOrderById.mockResolvedValueOnce(orderRow());
    getUserById.mockResolvedValueOnce({ _id: "U1", email: "a@b.com" });
    createPrimaryInvoice.mockRejectedValueOnce(new Error("boom"));
    await POST(makeReq());

    expect(claimOrderForZohoInvoice).not.toHaveBeenCalled();
    expect(claimOrderForPrimaryInvoice).not.toHaveBeenCalled();
    expect(releaseZohoInvoiceClaim).not.toHaveBeenCalled();
  });

  it("**passes staleClaimAfterMs** — async, queue-retried caller must be able to steal a claim stranded by a crashed prior attempt", async () => {
    setupSuccess();
    await POST(makeReq());
    expect(createPrimaryInvoice).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        claimOptions: expect.objectContaining({
          staleClaimAfterMs: 5 * 60 * 1000,
        }),
      })
    );
  });

  it("preserves `allowNull: true` from the pre-chokepoint implementation (legacy null zohoInvoiceId rows count as unclaimed)", async () => {
    setupSuccess();
    await POST(makeReq());
    expect(createPrimaryInvoice).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        claimOptions: expect.objectContaining({ allowNull: true }),
      })
    );
  });

  it("builds the context from the loaded order + user, not the request payload alone", async () => {
    setupSuccess();
    await POST(makeReq());
    const ctx = createPrimaryInvoice.mock.calls[0][0];
    // orderId must be the user-facing Order.orderId, not the _id from the
    // Cloud Tasks payload — it lands on the invoice as reference_number.
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

  it("**invoiceProvider === 'primary' → 200, chokepoint never called** — anti-double-billing across a flag flip-flop", async () => {
    getOrderById.mockResolvedValueOnce(
      orderRow({
        invoiceProvider: "primary",
        invoiceNumber: "TI/2026-27/00001",
        zohoInvoiceId: undefined,
      })
    );
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.provider).toBe("primary");
    expect(body.invoiceNumber).toBe("TI/2026-27/00001");
    expect(createPrimaryInvoice).not.toHaveBeenCalled();
    expect(getUserById).not.toHaveBeenCalled();
  });

  it("**zohoInvoiceId already set (real ID) → 200 success:true 'Already synced'**", async () => {
    getOrderById.mockResolvedValueOnce(
      orderRow({ zohoInvoiceId: "INV-EXISTING" })
    );
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toBe("Already synced");
    expect(body.zohoInvoiceId).toBe("INV-EXISTING");
    expect(createPrimaryInvoice).not.toHaveBeenCalled();
  });

  it("zohoInvoiceId === 'pending_creation' → proceeds (treated as unset)", async () => {
    getOrderById.mockResolvedValueOnce(
      orderRow({ zohoInvoiceId: "pending_creation" })
    );
    getUserById.mockResolvedValueOnce({ _id: "U1", email: "a@b.com" });
    createPrimaryInvoice.mockResolvedValueOnce({
      invoiceId: "INV-NEW",
      invoiceNumber: "INV-001",
      provider: "zoho",
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
  });
});

describe("Transient-retry paths (500, Cloud Tasks retries)", () => {
  it("user not found → 404 USER_NOT_FOUND; chokepoint never called", async () => {
    getOrderById.mockResolvedValueOnce(orderRow());
    getUserById.mockResolvedValueOnce(null);
    const res = await POST(makeReq());
    expect(res.status).toBe(404);
    expect(createPrimaryInvoice).not.toHaveBeenCalled();
  });

  it("**chokepoint throws (both engines failed) → 500 ZOHO_SYNC_ERROR**", async () => {
    getOrderById.mockResolvedValueOnce(orderRow());
    getUserById.mockResolvedValueOnce({ _id: "U1", email: "a@b.com" });
    createPrimaryInvoice.mockRejectedValueOnce(new Error("Zoho 503"));
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("ZOHO_SYNC_ERROR");
  });

  it("outer catch (getOrderById throw) → 500 ZOHO_SYNC_ERROR", async () => {
    getOrderById.mockRejectedValueOnce(new Error("Mongo down"));
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("ZOHO_SYNC_ERROR");
  });
});

describe("Response shape by provider", () => {
  it("primary → provider:'primary', TI number, no zohoInvoiceId", async () => {
    setupSuccess("primary");
    const res = await POST(makeReq());
    const body = await res.json();
    expect(body.provider).toBe("primary");
    expect(body.invoiceNumber).toBe("TI/2026-27/00001");
    expect(body.zohoInvoiceId).toBeUndefined();
  });

  it("zoho → provider:'zoho', zohoInvoiceId carried through", async () => {
    setupSuccess("zoho");
    const res = await POST(makeReq());
    const body = await res.json();
    expect(body.provider).toBe("zoho");
    expect(body.zohoInvoiceId).toBe("INV-NEW");
    expect(body.invoiceNumber).toBe("INV-001");
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
    // inferPeriodUnit returns item.periodUnit verbatim when present; without
    // it, a hosting item would be re-derived from registrationPeriod, which
    // is wrong for a renewal.
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
