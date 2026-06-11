/**
 * Tests for `app/api/cron/check-unprovisioned/route.ts` (slice 7hl, part 2).
 *
 * Two-part 30-minute cron:
 *   Part 1 — drain deferred PendingHosting rows via
 *            `provisionPendingHosting`, capped at CONCURRENCY=5 per chunk.
 *   Part 2 — list orders that paid+completed > 30 min ago but still have
 *            domain-side pending; email admin if any.
 *
 * Threat model:
 *  - **Unauthenticated cron-fire**: an attacker could spam the auto-
 *    retry side to force DA load. Dual-auth: x-cron-secret (timing-safe)
 *    OR admin session — failing both is 401.
 *  - **Cron crash on partial DA failure**: if one row's retry throws, the
 *    full cron must NOT die. Pinned via Promise.allSettled.
 *  - **Admin-email failure cascading**: if the alert email fails, the
 *    cron itself must still return 200 (otherwise external scheduler
 *    backs off + we lose every retry that DID succeed in part 1).
 *
 * Other pins:
 *  - Concurrency cap = 5 (chunked iteration)
 *  - retry-result aggregation: { attempted, succeeded, dropped, failed }
 *  - listStuckCompletedOrders called with staleAfterMs = 30 * 60 * 1000
 *  - Email called only when stuckOrders.length > 0
 *  - Response shape: { checked, retry }
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const authorizeCronRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cron-auth", () => ({ authorizeCronRequest }));

const isAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ AuthService: { isAdmin } }));

const sendAdminNotification = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  EmailService: { sendAdminNotification },
}));

const listStuckCompletedOrders = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({ listStuckCompletedOrders }));

const listDeferredPendingHostings = vi.hoisted(() => vi.fn());
const provisionPendingHosting = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/pending-hostings", () => ({
  listDeferredPendingHostings,
  provisionPendingHosting,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/cron/check-unprovisioned/route";

function makeReq(headers: Record<string, string> = {}) {
  return new NextRequest("https://example.com/api/cron/check-unprovisioned", {
    method: "GET",
    headers,
  });
}

beforeEach(() => {
  authorizeCronRequest.mockReset();
  isAdmin.mockReset();
  sendAdminNotification.mockReset();
  listStuckCompletedOrders.mockReset();
  listDeferredPendingHostings.mockReset();
  provisionPendingHosting.mockReset();
});

describe("Dual auth", () => {
  it("missing cron-secret + non-admin → 401 UNAUTHORIZED", async () => {
    authorizeCronRequest.mockReturnValueOnce(false);
    isAdmin.mockResolvedValueOnce(false);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
    // No work attempted under unauthenticated.
    expect(listDeferredPendingHostings).not.toHaveBeenCalled();
    expect(listStuckCompletedOrders).not.toHaveBeenCalled();
  });

  it("valid cron-secret → proceeds (admin check NOT consulted)", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    listDeferredPendingHostings.mockResolvedValueOnce([]);
    listStuckCompletedOrders.mockResolvedValueOnce([]);
    const res = await GET(makeReq({ "x-cron-secret": "valid" }));
    expect(res.status).toBe(200);
    expect(isAdmin).not.toHaveBeenCalled();
  });

  it("cron-secret fails but admin session → proceeds", async () => {
    authorizeCronRequest.mockReturnValueOnce(false);
    isAdmin.mockResolvedValueOnce(true);
    listDeferredPendingHostings.mockResolvedValueOnce([]);
    listStuckCompletedOrders.mockResolvedValueOnce([]);
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
  });
});

describe("Part 1 — drain deferred PendingHosting rows", () => {
  beforeEach(() => {
    authorizeCronRequest.mockReturnValue(true);
    listStuckCompletedOrders.mockResolvedValue([]); // keep part 2 silent
  });

  it("empty deferred list → retry counts all zero; provision NOT called", async () => {
    listDeferredPendingHostings.mockResolvedValueOnce([]);
    const res = await GET(makeReq({ "x-cron-secret": "ok" }));
    const body = await res.json();
    expect(body.retry).toEqual({
      attempted: 0,
      succeeded: 0,
      dropped: 0,
      failed: 0,
    });
    expect(provisionPendingHosting).not.toHaveBeenCalled();
  });

  it("CONCURRENCY=5 — 12 rows are drained in 3 chunks of 5/5/2 (asserted via in-flight high-water mark)", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ domain: `d${i}.com` }));
    listDeferredPendingHostings.mockResolvedValueOnce(rows);

    let inFlight = 0;
    let peak = 0;
    provisionPendingHosting.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // micro-delay so concurrent calls overlap
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { ok: true, dropped: false };
    });

    await GET(makeReq({ "x-cron-secret": "ok" }));
    expect(peak).toBeLessThanOrEqual(5);
    expect(provisionPendingHosting).toHaveBeenCalledTimes(12);
  });

  it("result aggregation: succeeded vs dropped vs failed", async () => {
    listDeferredPendingHostings.mockResolvedValueOnce([
      { domain: "a.com" },
      { domain: "b.com" },
      { domain: "c.com" },
      { domain: "d.com" },
    ]);
    provisionPendingHosting
      .mockResolvedValueOnce({ ok: true, dropped: false }) // succeeded
      .mockResolvedValueOnce({ ok: true, dropped: true }) // dropped
      .mockResolvedValueOnce({ ok: false }) // failed (ok false)
      .mockRejectedValueOnce(new Error("DA unreachable")); // failed (throw)

    const res = await GET(makeReq({ "x-cron-secret": "ok" }));
    const body = await res.json();
    expect(body.retry).toEqual({
      attempted: 4,
      succeeded: 1,
      dropped: 1,
      failed: 2,
    });
  });

  it("per-row throw does NOT abort the cron (Promise.allSettled)", async () => {
    listDeferredPendingHostings.mockResolvedValueOnce([
      { domain: "a.com" },
      { domain: "b.com" },
    ]);
    provisionPendingHosting
      .mockRejectedValueOnce(new Error("first row blew up"))
      .mockResolvedValueOnce({ ok: true, dropped: false });

    const res = await GET(makeReq({ "x-cron-secret": "ok" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.retry.failed).toBe(1);
    expect(body.retry.succeeded).toBe(1);
  });
});

describe("Part 2 — stuck-orders watchdog", () => {
  beforeEach(() => {
    authorizeCronRequest.mockReturnValue(true);
    listDeferredPendingHostings.mockResolvedValue([]); // no part-1 work
  });

  it("listStuckCompletedOrders called with staleAfterMs = 30 min", async () => {
    listStuckCompletedOrders.mockResolvedValueOnce([]);
    await GET(makeReq({ "x-cron-secret": "ok" }));
    expect(listStuckCompletedOrders).toHaveBeenCalledTimes(1);
    const opts = listStuckCompletedOrders.mock.calls[0][0];
    expect(opts.staleAfterMs).toBe(30 * 60 * 1000);
    // select hint pinned — projection narrows network payload
    expect(typeof opts.select).toBe("string");
    expect(opts.select).toContain("orderId");
    expect(opts.select).toContain("domains");
  });

  it("no stuck orders → email NOT sent; checked=0", async () => {
    listStuckCompletedOrders.mockResolvedValueOnce([]);
    const res = await GET(makeReq({ "x-cron-secret": "ok" }));
    const body = await res.json();
    expect(body.checked).toBe(0);
    expect(sendAdminNotification).not.toHaveBeenCalled();
  });

  it("≥1 stuck order → admin email sent; response still 200 with checked=N", async () => {
    listStuckCompletedOrders.mockResolvedValueOnce([
      {
        orderId: "ORD-001",
        userEmail: "x@y.com",
        userName: "Alice",
        createdAt: new Date(Date.now() - 90 * 60 * 1000), // 90 min ago
        domains: [
          { domainName: "a.com", status: "pending" },
          { domainName: "b.com", status: "registered" },
        ],
      },
      {
        orderId: "ORD-002",
        userEmail: null,
        userName: "Bob",
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
        domains: [{ domainName: "c.com", status: "pending" }],
      },
    ]);
    sendAdminNotification.mockResolvedValueOnce(undefined);

    const res = await GET(makeReq({ "x-cron-secret": "ok" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checked).toBe(2);
    expect(sendAdminNotification).toHaveBeenCalledTimes(1);
    const subjectArg = sendAdminNotification.mock.calls[0][1] as string;
    expect(subjectArg).toContain("2 paid order");
  });

  it("admin-email failure is SWALLOWED — cron still returns 200", async () => {
    listStuckCompletedOrders.mockResolvedValueOnce([
      {
        orderId: "ORD-003",
        userEmail: "z@y.com",
        userName: "Carol",
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
        domains: [{ domainName: "z.com", status: "pending" }],
      },
    ]);
    sendAdminNotification.mockRejectedValueOnce(
      new Error("SMTP relay down — credentials zoho_oauth_LEAK_ME_PLEASE")
    );

    const res = await GET(makeReq({ "x-cron-secret": "ok" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checked).toBe(1);
    // Leak guard — the response payload must NOT include the swallowed
    // sensitive error message.
    expect(JSON.stringify(body)).not.toContain("zoho_oauth_LEAK_ME_PLEASE");
  });
});

describe("Response shape (happy path)", () => {
  it("returns { checked, retry } via secureJsonResponse", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    listDeferredPendingHostings.mockResolvedValueOnce([{ domain: "a.com" }]);
    provisionPendingHosting.mockResolvedValueOnce({ ok: true, dropped: false });
    listStuckCompletedOrders.mockResolvedValueOnce([]);

    const res = await GET(makeReq({ "x-cron-secret": "ok" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      checked: 0,
      retry: { attempted: 1, succeeded: 1, dropped: 0, failed: 0 },
    });
  });
});

describe("Outer catch", () => {
  it("listDeferredPendingHostings throw → 500 INTERNAL_ERROR (sentinel not leaked)", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    listDeferredPendingHostings.mockRejectedValueOnce(
      new Error("Mongo connection refused — pwd $2a$12$BCRYPT_LEAK_ME")
    );
    const res = await GET(makeReq({ "x-cron-secret": "ok" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL_ERROR");
    // No raw upstream message in the body — pinned (this route, unlike
    // the assign-route family quirk, does NOT leak).
    expect(JSON.stringify(body)).not.toContain("$2a$12$BCRYPT_LEAK_ME");
  });
});
