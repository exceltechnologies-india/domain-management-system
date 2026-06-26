/**
 * Tests for the two Tokens-flow worker routes (Phase 2H):
 *   - app/api/workers/tokens-provision-pending/route.ts
 *   - app/api/workers/tokens-charge-recurring/route.ts
 *
 * Both are HTTP-invocable counterparts to the Phase 2D + 2E CLI scripts,
 * designed as Cloud Scheduler cron targets. Coverage:
 *  - Auth: missing/wrong CRON_SECRET → 401
 *  - Feature-flag guard: HOSTING_MANDATE_FLOW != 'tokens' → no-op 200
 *  - tokens-charge-recurring also refuses if RAZORPAY_KEY_ID is not rzp_live_*
 *  - Happy path: per-Hosting outcome counted, summary returned
 *  - Per-Hosting unexpected exception doesn't crash the batch (logged + counted in errors[])
 *
 * The service modules (tokens-da-provisioner, recurring-charge-service)
 * are mocked at module boundary; we test the route's orchestration only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.CRON_SECRET = "test_cron_secret";
});

const authorizeCronRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cron-auth", () => ({ authorizeCronRequest }));

const findPendingTokensFlowHostings = vi.hoisted(() => vi.fn());
const provisionTokensFlowHosting = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/payment/tokens-da-provisioner", () => ({
  findPendingTokensFlowHostings,
  provisionTokensFlowHosting,
}));

const findHostingsDueForCharge = vi.hoisted(() => vi.fn());
const chargeRecurringHosting = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/payment/recurring-charge-service", () => ({
  findHostingsDueForCharge,
  chargeRecurringHosting,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest } = await vi.importActual<typeof import("next/server")>(
  "next/server"
);

import { POST as provisionPOST } from "@/app/api/workers/tokens-provision-pending/route";
import { POST as chargePOST } from "@/app/api/workers/tokens-charge-recurring/route";

function makeReq() {
  return new NextRequest("https://example.com/api/workers/x", { method: "POST" });
}

beforeEach(() => {
  authorizeCronRequest.mockReset().mockReturnValue(true);
  findPendingTokensFlowHostings.mockReset().mockResolvedValue([]);
  provisionTokensFlowHosting.mockReset();
  findHostingsDueForCharge.mockReset().mockResolvedValue([]);
  chargeRecurringHosting.mockReset();
  process.env.HOSTING_MANDATE_FLOW = "tokens";
  process.env.RAZORPAY_KEY_ID = "rzp_live_T5NRBOq7ByM414";
});

describe("/api/workers/tokens-provision-pending", () => {
  it("unauthorized → 401", async () => {
    authorizeCronRequest.mockReturnValueOnce(false);
    const res = await provisionPOST(makeReq());
    expect(res.status).toBe(401);
    expect(findPendingTokensFlowHostings).not.toHaveBeenCalled();
  });

  it("HOSTING_MANDATE_FLOW != 'tokens' → no-op 200 with all-zero counts", async () => {
    process.env.HOSTING_MANDATE_FLOW = "subscriptions";
    const res = await provisionPOST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.counts).toEqual({
      activated: 0,
      skipped: 0,
      da_unreachable: 0,
      collision_exhausted: 0,
      hard_failure: 0,
    });
    expect(findPendingTokensFlowHostings).not.toHaveBeenCalled();
  });

  it("happy path: counts each outcome and returns summary", async () => {
    findPendingTokensFlowHostings.mockResolvedValueOnce([
      { _id: "h1", domainName: "a.com" },
      { _id: "h2", domainName: "b.com" },
      { _id: "h3", domainName: "c.com" },
    ]);
    provisionTokensFlowHosting
      .mockResolvedValueOnce({ outcome: "activated", domainName: "a.com", daUsername: "u1" })
      .mockResolvedValueOnce({ outcome: "da_unreachable", domainName: "b.com", reason: "timeout" })
      .mockResolvedValueOnce({ outcome: "skipped", domainName: "c.com" });

    const res = await provisionPOST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.counts).toEqual({
      activated: 1,
      skipped: 1,
      da_unreachable: 1,
      collision_exhausted: 0,
      hard_failure: 0,
    });
  });

  it("per-Hosting unexpected exception is logged + counted in errors[], batch continues", async () => {
    findPendingTokensFlowHostings.mockResolvedValueOnce([
      { _id: "h1", domainName: "a.com" },
      { _id: "h2", domainName: "b.com" },
    ]);
    provisionTokensFlowHosting
      .mockRejectedValueOnce(new Error("Mongo write conflict"))
      .mockResolvedValueOnce({ outcome: "activated", domainName: "b.com", daUsername: "u2" });

    const res = await provisionPOST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.counts.activated).toBe(1);  // batch continued after the throw
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toMatch(/Mongo write conflict/);
  });
});

describe("/api/workers/tokens-charge-recurring", () => {
  it("unauthorized → 401", async () => {
    authorizeCronRequest.mockReturnValueOnce(false);
    const res = await chargePOST(makeReq());
    expect(res.status).toBe(401);
    expect(findHostingsDueForCharge).not.toHaveBeenCalled();
  });

  it("HOSTING_MANDATE_FLOW != 'tokens' → no-op 200", async () => {
    process.env.HOSTING_MANDATE_FLOW = "subscriptions";
    const res = await chargePOST(makeReq());
    expect(res.status).toBe(200);
    expect(findHostingsDueForCharge).not.toHaveBeenCalled();
  });

  it("RAZORPAY_KEY_ID is not rzp_live_* → 400 NON_LIVE_KEY", async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_keyid";
    const res = await chargePOST(makeReq());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("NON_LIVE_KEY");
    expect(findHostingsDueForCharge).not.toHaveBeenCalled();
  });

  it("happy path: counts each outcome and returns summary", async () => {
    findHostingsDueForCharge.mockResolvedValueOnce([
      { _id: "h1", domainName: "a.com" },
      { _id: "h2", domainName: "b.com" },
      { _id: "h3", domainName: "c.com" },
      { _id: "h4", domainName: "d.com" },
    ]);
    chargeRecurringHosting
      .mockResolvedValueOnce({ outcome: "succeeded", domainName: "a.com", attemptCount: 1 })
      .mockResolvedValueOnce({ outcome: "retry_scheduled", domainName: "b.com", attemptCount: 1 })
      .mockResolvedValueOnce({ outcome: "abandoned", domainName: "c.com", attemptCount: 4 })
      .mockResolvedValueOnce({ outcome: "skipped", domainName: "d.com", attemptCount: 1, reason: "already succeeded" });

    const res = await chargePOST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.counts).toEqual({
      succeeded: 1,
      retry_scheduled: 1,
      abandoned: 1,
      skipped: 1,
    });
  });

  it("per-Hosting unexpected exception logged + batch continues", async () => {
    findHostingsDueForCharge.mockResolvedValueOnce([
      { _id: "h1", domainName: "a.com" },
      { _id: "h2", domainName: "b.com" },
    ]);
    chargeRecurringHosting
      .mockRejectedValueOnce(new Error("Razorpay API 500"))
      .mockResolvedValueOnce({ outcome: "succeeded", domainName: "b.com", attemptCount: 1 });

    const res = await chargePOST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.counts.succeeded).toBe(1);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toMatch(/Razorpay API 500/);
  });
});
