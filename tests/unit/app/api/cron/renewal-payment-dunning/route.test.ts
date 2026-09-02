/**
 * Tests for `app/api/cron/renewal-payment-dunning/route.ts` (Primary
 * Billing Integration Phase 2).
 *
 * Chases renewal Orders (orderType='renewal') stuck in status='pending'
 * because the customer never completed Razorpay checkout at
 * /api/user/hosting/renew — no dedup/expiry exists there today, so without
 * this cron an abandoned checkout is never followed up.
 *
 * Pins:
 *  - Dual auth: cron-secret OR admin session (mirrors pending-sweeper)
 *  - Query filter: status='pending', orderType='renewal',
 *    dunningAbandonedAt not-exists, createdAt < earliest-stage cutoff
 *  - Stage selection: walks RENEWAL_DUNNING_HOURS descending, picks the
 *    highest stage the order's age has reached that hasn't been sent yet
 *    (dunningLastStageHours < stage)
 *  - An order not yet old enough for ANY unsent stage is skipped (no email,
 *    no write)
 *  - Sending the FINAL stage also sets dunningAbandonedAt (stops future
 *    reminders) — does NOT touch `status`
 *  - Sending a NON-final stage does NOT set dunningAbandonedAt
 *  - Missing userEmail → skipped (not counted as sent), doesn't crash
 *  - Per-order send failure is swallowed — doesn't stop the rest of the
 *    batch, doesn't fail the cron response
 *  - Empty candidate set → 200 with all-zero counts, no email calls
 *  - Response shape: { checked, sent, abandoned, skipped }
 *  - Outer catch → 500 INTERNAL_ERROR
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const authorizeCronRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cron-auth", () => ({ authorizeCronRequest }));

const isAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ AuthService: { isAdmin } }));

const sendRenewalPaymentPendingEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  EmailService: { sendRenewalPaymentPendingEmail },
}));

const orderFindLean = vi.hoisted(() => vi.fn());
const orderFindSelect = vi.hoisted(() => vi.fn());
const orderFind = vi.hoisted(() => vi.fn());
const orderUpdateOne = vi.hoisted(() => vi.fn());
vi.mock("@/models/Order", () => ({
  default: { find: orderFind, updateOne: orderUpdateOne },
}));

vi.mock("@/lib/mongodb", () => ({
  default: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/config/automation", () => ({
  AUTOMATION_CONFIG: { RENEWAL_DUNNING_HOURS: [24, 72, 168] },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/cron/renewal-payment-dunning/route";

function makeReq(headers: Record<string, string> = {}) {
  return new NextRequest("https://example.com/api/cron/renewal-payment-dunning", {
    method: "GET",
    headers,
  });
}

function setupMongoChain(rows: unknown[]) {
  orderFindLean.mockResolvedValue(rows);
  orderFindSelect.mockReturnValue({ lean: orderFindLean });
  orderFind.mockReturnValue({ select: orderFindSelect });
}

const HOUR = 60 * 60 * 1000;

function orderAged(hoursOld: number, overrides: Record<string, unknown> = {}) {
  return {
    _id: "OID-1",
    orderId: "rnw_1",
    userId: "U1",
    userEmail: "u@x.test",
    userName: "Alice",
    amount: 1500,
    currency: "INR",
    createdAt: new Date(Date.now() - hoursOld * HOUR),
    domains: [{ domainName: "alice.com", hostingPlan: { name: "Starter" } }],
    ...overrides,
  };
}

beforeEach(() => {
  authorizeCronRequest.mockReset();
  isAdmin.mockReset();
  sendRenewalPaymentPendingEmail.mockReset().mockResolvedValue(true);
  orderFindLean.mockReset();
  orderFindSelect.mockReset();
  orderFind.mockReset();
  orderUpdateOne.mockReset().mockResolvedValue({ modifiedCount: 1 });
  setupMongoChain([]);
});

describe("Dual auth", () => {
  it("no cron-secret + non-admin → 401 UNAUTHORIZED; no DB read", async () => {
    authorizeCronRequest.mockReturnValueOnce(false);
    isAdmin.mockResolvedValueOnce(false);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    expect(orderFind).not.toHaveBeenCalled();
  });

  it("valid cron-secret → proceeds (admin check skipped)", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    const res = await GET(makeReq({ "x-cron-secret": "ok" }));
    expect(res.status).toBe(200);
    expect(isAdmin).not.toHaveBeenCalled();
  });

  it("cron-secret fails but admin session → proceeds", async () => {
    authorizeCronRequest.mockReturnValueOnce(false);
    isAdmin.mockResolvedValueOnce(true);
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
  });
});

describe("Query shape", () => {
  beforeEach(() => authorizeCronRequest.mockReturnValue(true));

  it("filter: status='pending', orderType='renewal', dunningAbandonedAt not-exists, createdAt < 24h cutoff (earliest stage)", async () => {
    await GET(makeReq());
    expect(orderFind).toHaveBeenCalledTimes(1);
    const filter = orderFind.mock.calls[0][0];
    expect(filter.status).toBe("pending");
    expect(filter.orderType).toBe("renewal");
    expect(filter.dunningAbandonedAt).toEqual({ $exists: false });
    const cutoffMs = (filter.createdAt.$lt as Date).getTime();
    expect(cutoffMs).toBeGreaterThanOrEqual(Date.now() - 24 * HOUR - 1000);
    expect(cutoffMs).toBeLessThanOrEqual(Date.now() - 24 * HOUR + 1000);
  });
});

describe("Stage selection + escalation", () => {
  beforeEach(() => authorizeCronRequest.mockReturnValue(true));

  it("order not old enough for any stage → skipped, no email, no write", async () => {
    setupMongoChain([orderAged(10)]); // younger than the 24h first stage
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body).toEqual({ checked: 1, sent: 0, abandoned: 0, skipped: 1 });
    expect(sendRenewalPaymentPendingEmail).not.toHaveBeenCalled();
    expect(orderUpdateOne).not.toHaveBeenCalled();
  });

  it("30h old, no prior stage sent → sends the 24h stage (not final)", async () => {
    setupMongoChain([orderAged(30)]);
    await GET(makeReq());
    expect(sendRenewalPaymentPendingEmail).toHaveBeenCalledWith(
      "u@x.test",
      "Alice",
      expect.objectContaining({ stageHours: 24, isFinalStage: false })
    );
    expect(orderUpdateOne).toHaveBeenCalledWith(
      { _id: "OID-1" },
      { $set: { dunningLastStageHours: 24 } }
    );
  });

  it("already sent the 24h stage, now 80h old → sends the 72h stage (not the 24h one again)", async () => {
    setupMongoChain([orderAged(80, { dunningLastStageHours: 24 })]);
    await GET(makeReq());
    expect(sendRenewalPaymentPendingEmail).toHaveBeenCalledWith(
      "u@x.test",
      "Alice",
      expect.objectContaining({ stageHours: 72, isFinalStage: false })
    );
  });

  it("200h old, final (168h) stage not yet sent → sends final stage AND sets dunningAbandonedAt", async () => {
    setupMongoChain([orderAged(200, { dunningLastStageHours: 72 })]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(sendRenewalPaymentPendingEmail).toHaveBeenCalledWith(
      "u@x.test",
      "Alice",
      expect.objectContaining({ stageHours: 168, isFinalStage: true })
    );
    expect(orderUpdateOne).toHaveBeenCalledWith(
      { _id: "OID-1" },
      { $set: expect.objectContaining({ dunningLastStageHours: 168, dunningAbandonedAt: expect.any(Date) }) }
    );
    expect(body).toEqual({ checked: 1, sent: 1, abandoned: 1, skipped: 0 });
  });

  it("final stage already sent (dunningLastStageHours=168) → skipped, not re-sent", async () => {
    setupMongoChain([orderAged(300, { dunningLastStageHours: 168 })]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(sendRenewalPaymentPendingEmail).not.toHaveBeenCalled();
    expect(body.skipped).toBe(1);
  });
});

describe("Resilience", () => {
  beforeEach(() => authorizeCronRequest.mockReturnValue(true));

  it("missing userEmail → skipped, no crash, no email attempt", async () => {
    setupMongoChain([orderAged(30, { userEmail: undefined })]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(sendRenewalPaymentPendingEmail).not.toHaveBeenCalled();
    expect(body.skipped).toBe(1);
  });

  it("email send throws for one order → swallowed, doesn't stop the batch or fail the response", async () => {
    setupMongoChain([orderAged(30), orderAged(30, { _id: "OID-2", orderId: "rnw_2" })]);
    sendRenewalPaymentPendingEmail
      .mockRejectedValueOnce(new Error("SMTP down"))
      .mockResolvedValueOnce(true);
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sent).toBe(1); // only the second order counted as sent
    expect(orderUpdateOne).toHaveBeenCalledTimes(1); // not called for the failed one
  });

  it("empty candidate set → 200, all-zero counts, no email calls", async () => {
    setupMongoChain([]);
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ checked: 0, sent: 0, abandoned: 0, skipped: 0 });
    expect(sendRenewalPaymentPendingEmail).not.toHaveBeenCalled();
  });

  it("DB throw → 500 INTERNAL_ERROR", async () => {
    orderFind.mockImplementationOnce(() => {
      throw new Error("Mongo timeout: secret-XYZ");
    });
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("secret-XYZ");
  });
});
