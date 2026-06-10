/**
 * Tests for `app/api/cron/check-hosting-expiry/route.ts` (slice 7gw,
 * part 1). The daily cron that finds active hostings whose
 * expiryDate has passed and queues per-hosting suspension tasks to
 * Cloud Tasks.
 *
 * Pins:
 *  - **Dual-auth gate**: authorizeCronRequest (timing-safe header
 *    check) is tried FIRST. Only if that fails does the route
 *    fall back to admin session via AuthService.isAdmin. Pinned
 *    so a refactor that drops the cron path (forcing the cron to
 *    log in as an admin) is flagged.
 *  - Neither auth path passes → 401 UNAUTHORIZED
 *  - listExpiredActiveHostings called with `getCurrentDate()`
 *    (single source of truth for "today" — pinned so a refactor
 *    that calls `new Date()` directly is caught)
 *  - **Per-item failure isolation**: createHttpTask throw on one
 *    hosting must NOT abort the loop. results.queued + results.
 *    failed counters tracked separately; .details array names
 *    each domain with its outcome (so admin can see which
 *    specific ones failed).
 *  - Queue name from `GCP_QUEUE_NAME` env, fallback
 *    'hosting-expiry-queue'
 *  - Worker URL: `${NEXTAUTH_URL}/api/v1/workers/process-hosting-
 *    expiry`
 *  - Empty expired-list → success with all counters zero
 *  - Outer catch → 500 AUTO_SUSPEND_FAILED 'Internal Server Error
 *    during auto-suspend queuing'
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const authorizeCronRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cron-auth", () => ({ authorizeCronRequest }));

const isAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { isAdmin },
}));

const listExpiredActiveHostings = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hostings", () => ({ listExpiredActiveHostings }));

const getCurrentDate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/dateUtils", () => ({ getCurrentDate }));

const createHttpTask = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cloud-tasks", () => ({ createHttpTask }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/cron/check-hosting-expiry/route";

function makeReq() {
  return new NextRequest(
    "https://example.com/api/cron/check-hosting-expiry",
    { method: "GET" }
  );
}

const TODAY = new Date("2026-06-10T00:00:00.000Z");

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  authorizeCronRequest.mockReset();
  isAdmin.mockReset();
  listExpiredActiveHostings.mockReset();
  getCurrentDate.mockReset().mockReturnValue(TODAY);
  createHttpTask.mockReset();
  process.env.GCP_QUEUE_NAME = "test-queue";
  process.env.NEXTAUTH_URL = "https://app.test";
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
});

describe("Dual-auth gate", () => {
  it("authorizeCronRequest TRUE → proceeds without admin check", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    listExpiredActiveHostings.mockResolvedValueOnce([]);
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    expect(isAdmin).not.toHaveBeenCalled();
  });

  it("authorizeCronRequest FALSE → falls back to admin session", async () => {
    authorizeCronRequest.mockReturnValueOnce(false);
    isAdmin.mockResolvedValueOnce(true);
    listExpiredActiveHostings.mockResolvedValueOnce([]);
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    expect(isAdmin).toHaveBeenCalled();
  });

  it("BOTH auth paths fail → 401 UNAUTHORIZED; NO hosting lookup", async () => {
    authorizeCronRequest.mockReturnValueOnce(false);
    isAdmin.mockResolvedValueOnce(false);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
    expect(listExpiredActiveHostings).not.toHaveBeenCalled();
  });
});

describe("getCurrentDate as single source of truth", () => {
  it("listExpiredActiveHostings called with getCurrentDate()'s return value", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    listExpiredActiveHostings.mockResolvedValueOnce([]);
    await GET(makeReq());
    expect(listExpiredActiveHostings).toHaveBeenCalledWith(TODAY);
  });
});

describe("Per-item Cloud Tasks fan-out", () => {
  it("queues a task per hosting with { hostingId } payload to the correct queue and worker URL", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    listExpiredActiveHostings.mockResolvedValueOnce([
      { _id: "H1", domainName: "a.com" },
      { _id: "H2", domainName: "b.com" },
    ]);
    createHttpTask.mockResolvedValue(undefined);

    await GET(makeReq());
    expect(createHttpTask).toHaveBeenCalledTimes(2);
    expect(createHttpTask).toHaveBeenCalledWith(
      "test-queue",
      "https://app.test/api/v1/workers/process-hosting-expiry",
      { hostingId: "H1" }
    );
    expect(createHttpTask).toHaveBeenCalledWith(
      "test-queue",
      "https://app.test/api/v1/workers/process-hosting-expiry",
      { hostingId: "H2" }
    );
  });

  it("uses queue default 'hosting-expiry-queue' when GCP_QUEUE_NAME is missing", async () => {
    delete process.env.GCP_QUEUE_NAME;
    authorizeCronRequest.mockReturnValueOnce(true);
    listExpiredActiveHostings.mockResolvedValueOnce([
      { _id: "H1", domainName: "a.com" },
    ]);
    createHttpTask.mockResolvedValueOnce(undefined);

    await GET(makeReq());
    expect(createHttpTask).toHaveBeenCalledWith(
      "hosting-expiry-queue",
      expect.any(String),
      expect.any(Object)
    );
  });
});

describe("Per-item failure isolation", () => {
  it("one createHttpTask throw → does NOT abort loop; queued/failed tracked separately + per-domain details", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    listExpiredActiveHostings.mockResolvedValueOnce([
      { _id: "H1", domainName: "ok1.com" },
      { _id: "H_BROKEN", domainName: "broken.com" },
      { _id: "H3", domainName: "ok2.com" },
    ]);
    createHttpTask
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Cloud Tasks 503"))
      .mockResolvedValueOnce(undefined);

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.queued).toBe(2);
    expect(body.data.failed).toBe(1);
    expect(body.data.details).toEqual([
      "Queued: ok1.com",
      "Failed to queue: broken.com",
      "Queued: ok2.com",
    ]);
  });
});

describe("Empty list", () => {
  it("no expired hostings → 200 with all-zero counters", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    listExpiredActiveHostings.mockResolvedValueOnce([]);

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ queued: 0, failed: 0, details: [] });
    expect(createHttpTask).not.toHaveBeenCalled();
  });
});

describe("Outer catch", () => {
  it("listExpiredActiveHostings throw → 500 AUTO_SUSPEND_FAILED", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    listExpiredActiveHostings.mockRejectedValueOnce(new Error("DB down"));
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("AUTO_SUSPEND_FAILED");
    expect(body.error).toBe(
      "Internal Server Error during auto-suspend queuing"
    );
  });
});
