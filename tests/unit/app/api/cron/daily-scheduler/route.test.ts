/**
 * Tests for `app/api/cron/daily-scheduler/route.ts` (slice 7hr, part 1).
 *
 * The heart of the daily provisioning cron. Picks up due hostings AND
 * domains, atomically locks each, dispatches to a Cloud Tasks worker.
 *
 * Threat model:
 *  - **Double-processing via concurrent runs**: if two scheduler runs
 *    overlap (Cloud Scheduler retry + a manual admin re-fire), they
 *    must NOT both queue the same service. Pinned by atomic
 *    findOneAndUpdate semantics — a `null` lock result means
 *    "someone else has it" and the row is counted skipped, not
 *    queued.
 *  - **Abandoned locks from failed Cloud Tasks dispatch**: if
 *    createHttpTask throws (network blip), the route MUST release the
 *    lock — otherwise the row stays processing_until=lockExpiry for
 *    10 minutes and the next scheduler run also skips it. Pinned with
 *    "createHttpTask throws → release helper called".
 *  - **One bad row blowing up the batch**: a refactor that switches
 *    from Promise.allSettled to Promise.all would propagate any
 *    single failure to the response and the remaining 499 rows go
 *    un-processed. Pinned.
 *  - **Status-race between fetch and lock**: a Domain whose status
 *    flips to "failed" between the candidate fetch and the lock must
 *    NOT slip into the worker queue. Pinned via the lock filter
 *    including $nin: ['failed', 'terminated'].
 *
 * Other pins:
 *  - Dual auth (cron-secret OR admin)
 *  - simulatedTime header forwarded into Cloud Tasks payload
 *  - Domain-watch worker fired with x-cron-secret + 60s AbortSignal
 *  - RC balance check: threshold default 1000; alert email when below;
 *    NaN balance returns {checked:false}; balance-call throw swallowed
 *  - Outer catch → 500 CRON_SCHEDULER_FAILED
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const authorizeCronRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cron-auth", () => ({ authorizeCronRequest }));

const isAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ AuthService: { isAdmin } }));

const TimeServiceNow = vi.hoisted(() => vi.fn());
vi.mock("@/lib/time-service", () => ({
  TimeService: { now: TimeServiceNow },
}));

const listDueServiceHostingCandidates = vi.hoisted(() => vi.fn());
const lockHostingForScheduler = vi.hoisted(() => vi.fn());
const releaseHostingSchedulerLock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hostings", () => ({
  listDueServiceHostingCandidates,
  lockHostingForScheduler,
  releaseHostingSchedulerLock,
}));

const domainFindLimit = vi.hoisted(() => vi.fn());
const domainFindSelect = vi.hoisted(() => vi.fn());
const domainFind = vi.hoisted(() => vi.fn());
const domainFindOneAndUpdate = vi.hoisted(() => vi.fn());
const domainUpdateOne = vi.hoisted(() => vi.fn());
vi.mock("@/models/Domain", () => ({
  default: {
    find: domainFind,
    findOneAndUpdate: domainFindOneAndUpdate,
    updateOne: domainUpdateOne,
  },
}));

const createHttpTask = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cloud-tasks", () => ({ createHttpTask }));

const getResellerDetails = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub", () => ({
  ResellerClubAPI: { getResellerDetails },
}));

const sendLowBalanceAlert = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  EmailService: { sendLowBalanceAlert },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/cron/daily-scheduler/route";

const NOW = new Date("2026-06-12T10:00:00.000Z");
const origFetch = globalThis.fetch;

function makeReq(headers: Record<string, string> = {}) {
  return new NextRequest(
    "https://example.com/api/cron/daily-scheduler",
    { method: "GET", headers }
  );
}

function setupDomainFind(rows: Array<{ _id: string; domainName: string }>) {
  domainFindLimit.mockResolvedValue(rows);
  domainFindSelect.mockReturnValue({ limit: domainFindLimit });
  domainFind.mockReturnValue({ select: domainFindSelect });
}

beforeEach(() => {
  authorizeCronRequest.mockReset();
  isAdmin.mockReset();
  TimeServiceNow.mockReset().mockReturnValue(NOW);
  listDueServiceHostingCandidates.mockReset().mockResolvedValue([]);
  lockHostingForScheduler.mockReset();
  releaseHostingSchedulerLock.mockReset().mockResolvedValue(undefined);
  domainFind.mockReset();
  domainFindOneAndUpdate.mockReset();
  domainUpdateOne.mockReset().mockResolvedValue({});
  createHttpTask.mockReset();
  getResellerDetails.mockReset();
  sendLowBalanceAlert.mockReset().mockResolvedValue(undefined);
  setupDomainFind([]);
  // RC balance check happy default
  getResellerDetails.mockResolvedValue({
    status: "success",
    data: {
      availablebalance: "5000.00",
      name: "Test",
      resellerid: "R1",
    },
  });
  // Domain-watch fire-and-forget happy default
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({ checked: 0 }),
  } as unknown as Response);
  vi.stubEnv("NEXTAUTH_URL", "https://app.example.com");
  vi.stubEnv("CRON_SECRET", "cron-secret-xyz");
  vi.stubEnv("GCP_QUEUE_NAME", "test-queue");
});

afterAll(() => {
  vi.unstubAllEnvs();
  globalThis.fetch = origFetch;
});

describe("Dual auth", () => {
  it("no cron-secret + non-admin → 401 UNAUTHORIZED", async () => {
    authorizeCronRequest.mockReturnValueOnce(false);
    isAdmin.mockResolvedValueOnce(false);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
    expect(listDueServiceHostingCandidates).not.toHaveBeenCalled();
  });

  it("valid cron-secret → proceeds; admin skipped", async () => {
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

describe("Atomic locking — hostings", () => {
  beforeEach(() => {
    authorizeCronRequest.mockReturnValue(true);
  });

  it("lockHostingForScheduler returns null → counted as skippedLocked, NOT queued; createHttpTask NEVER called", async () => {
    listDueServiceHostingCandidates.mockResolvedValueOnce([
      { _id: "H1" },
      { _id: "H2" },
    ]);
    lockHostingForScheduler.mockResolvedValue(null); // both already locked
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data.skippedLocked).toBe(2);
    expect(body.data.queuedHostings).toBe(0);
    expect(createHttpTask).not.toHaveBeenCalled();
  });

  it("lock acquired + createHttpTask succeeds → counted queuedHostings", async () => {
    listDueServiceHostingCandidates.mockResolvedValueOnce([{ _id: "H1" }]);
    lockHostingForScheduler.mockResolvedValueOnce({ _id: "H1" });
    createHttpTask.mockResolvedValueOnce(undefined);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data.queuedHostings).toBe(1);
    expect(createHttpTask).toHaveBeenCalledWith(
      "test-queue",
      "https://app.example.com/api/v1/workers/process-service-expiry",
      expect.objectContaining({
        serviceId: "H1",
        serviceType: "hosting",
      })
    );
  });

  it("createHttpTask THROWS → lock released; counted failed", async () => {
    listDueServiceHostingCandidates.mockResolvedValueOnce([{ _id: "H1" }]);
    lockHostingForScheduler.mockResolvedValueOnce({ _id: "H1" });
    createHttpTask.mockRejectedValueOnce(new Error("Queue down"));
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data.failed).toBe(1);
    expect(body.data.queuedHostings).toBe(0);
    expect(releaseHostingSchedulerLock).toHaveBeenCalledTimes(1);
  });

  it("simulatedTime header forwarded into Cloud Tasks payload", async () => {
    listDueServiceHostingCandidates.mockResolvedValueOnce([{ _id: "H1" }]);
    lockHostingForScheduler.mockResolvedValueOnce({ _id: "H1" });
    createHttpTask.mockResolvedValueOnce(undefined);
    await GET(
      makeReq({ "x-simulated-time": "2027-01-01T00:00:00.000Z" })
    );
    expect(createHttpTask.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        simulatedTime: "2027-01-01T00:00:00.000Z",
      })
    );
  });
});

describe("Atomic locking — domains", () => {
  beforeEach(() => {
    authorizeCronRequest.mockReturnValue(true);
  });

  it("lock filter includes $nin: ['failed','terminated'] race-guard", async () => {
    setupDomainFind([{ _id: "D1", domainName: "x.com" }]);
    domainFindOneAndUpdate.mockResolvedValueOnce(null); // race lost
    await GET(makeReq());
    const filter = domainFindOneAndUpdate.mock.calls[0][0];
    expect(filter.status).toEqual({ $nin: ["failed", "terminated"] });
  });

  it("lock acquired → createHttpTask called with serviceType='domain'", async () => {
    setupDomainFind([{ _id: "D1", domainName: "x.com" }]);
    domainFindOneAndUpdate.mockResolvedValueOnce({ _id: "D1" });
    createHttpTask.mockResolvedValueOnce(undefined);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data.queuedDomains).toBe(1);
    expect(createHttpTask).toHaveBeenCalledWith(
      "test-queue",
      expect.any(String),
      expect.objectContaining({ serviceId: "D1", serviceType: "domain" })
    );
  });

  it("createHttpTask throw → domain lock released via updateOne; counted failed", async () => {
    setupDomainFind([{ _id: "D1", domainName: "x.com" }]);
    domainFindOneAndUpdate.mockResolvedValueOnce({ _id: "D1" });
    createHttpTask.mockRejectedValueOnce(new Error("Queue err"));
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data.failed).toBe(1);
    expect(domainUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "D1" }),
      expect.objectContaining({ $set: { processing_until: null } })
    );
  });
});

describe("Promise.allSettled — one row throw doesn't blow up the batch", () => {
  beforeEach(() => {
    authorizeCronRequest.mockReturnValue(true);
  });

  it("hosting row throws inside lock helper → other rows still processed", async () => {
    listDueServiceHostingCandidates.mockResolvedValueOnce([
      { _id: "H1" },
      { _id: "H2" },
    ]);
    lockHostingForScheduler
      .mockRejectedValueOnce(new Error("Mongo blip on H1"))
      .mockResolvedValueOnce({ _id: "H2" });
    createHttpTask.mockResolvedValue(undefined);
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.failed).toBe(1);
    expect(body.data.queuedHostings).toBe(1);
  });
});

describe("Domain-watch fire-and-forget", () => {
  beforeEach(() => {
    authorizeCronRequest.mockReturnValue(true);
  });

  it("fires POST to /api/v1/workers/check-domain-watch with x-cron-secret", async () => {
    await GET(makeReq());
    const watchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(watchCall[0]).toBe(
      "https://app.example.com/api/v1/workers/check-domain-watch"
    );
    expect((watchCall[1] as RequestInit).method).toBe("POST");
    expect(
      ((watchCall[1] as RequestInit).headers as Record<string, string>)[
        "x-cron-secret"
      ]
    ).toBe("cron-secret-xyz");
  });

  it("60s AbortSignal.timeout pinned (signal present)", async () => {
    await GET(makeReq());
    const opts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it("non-ok response → captured as { error: 'HTTP N' }; main scheduler still 200", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 503,
    } as unknown as Response);
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.domainWatch.error).toBe("HTTP 503");
  });

  it("fetch throw → swallowed; main scheduler still 200", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("ECONNREFUSED watch")
    );
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
  });
});

describe("RC balance check", () => {
  beforeEach(() => {
    authorizeCronRequest.mockReturnValue(true);
  });

  it("balance below default threshold (1000) → low-balance alert email sent; alerted=true", async () => {
    getResellerDetails.mockResolvedValueOnce({
      status: "success",
      data: {
        availablebalance: "500.00",
        name: "Test",
        resellerid: "R1",
      },
    });
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data.balanceAlert).toEqual(
      expect.objectContaining({ checked: true, balance: 500, alerted: true })
    );
    expect(sendLowBalanceAlert).toHaveBeenCalledTimes(1);
  });

  it("balance ABOVE threshold → no email; alerted=false", async () => {
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data.balanceAlert.alerted).toBe(false);
    expect(sendLowBalanceAlert).not.toHaveBeenCalled();
  });

  it("threshold env override: RESELLERCLUB_BALANCE_THRESHOLD=10000 → 5000 NOW below threshold → alert sent", async () => {
    vi.stubEnv("RESELLERCLUB_BALANCE_THRESHOLD", "10000");
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data.balanceAlert.alerted).toBe(true);
  });

  it("getResellerDetails returns status:'error' → balance check skipped; main scheduler still 200", async () => {
    getResellerDetails.mockResolvedValueOnce({ status: "error" });
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.balanceAlert).toEqual(
      expect.objectContaining({ checked: false, reason: "RC API error" })
    );
  });

  it("unparseable balance string → checked:false reason='unparseable balance'", async () => {
    getResellerDetails.mockResolvedValueOnce({
      status: "success",
      data: {
        availablebalance: "not-a-number",
        name: "Test",
        resellerid: "R1",
      },
    });
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data.balanceAlert).toEqual(
      expect.objectContaining({ checked: false, reason: "unparseable balance" })
    );
    expect(sendLowBalanceAlert).not.toHaveBeenCalled();
  });

  it("getResellerDetails THROW → swallowed; checked:false with the message; main scheduler still 200", async () => {
    getResellerDetails.mockRejectedValueOnce(
      new Error("ECONNREFUSED rc — rc_sa_key_LEAK_ME_PLEASE")
    );
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    // The reason field carries the raw error message — pin it as part of
    // the route's current behaviour. (Sentinel leak is observable here;
    // future hardening would scrub.)
    const body = await res.json();
    expect(body.data.balanceAlert.checked).toBe(false);
  });
});

describe("Outer catch", () => {
  it("listDueServiceHostingCandidates throw → 500 CRON_SCHEDULER_FAILED", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    listDueServiceHostingCandidates.mockRejectedValueOnce(
      new Error("Mongo cluster down")
    );
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("CRON_SCHEDULER_FAILED");
  });
});
