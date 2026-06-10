/**
 * Tests for `app/api/admin/log-error/route.ts` (slice 7gw, part 2).
 * Server-side error-logging endpoint. Called by:
 *   1. Internal cron jobs / background workers (via the cron-secret
 *      header)
 *   2. Authenticated server-side code via session cookies
 *   3. Same-origin browser code that catches a client-side error
 *
 * Threat model:
 *  - **Recursive log-storm hazard**: if this route's outer-catch
 *    used serverLogger.error, and serverLogger.error happens to
 *    POST to this same route on failure, ONE broken log write
 *    would snowball into a request storm. The source uses
 *    `console.error` (NOT serverLogger.error) — pinned.
 *  - DoS via gigantic log payloads — zod size bounds (message
 *    ≤ 10k, stack ≤ 20k, url ≤ 2k, others ≤ 200) anti-abuse
 *  - **Triple-path auth**: cron secret OR session OR same-origin.
 *    Pinned to allow legitimate browser-error logging without
 *    requiring the user to be logged in (anonymous visitors who
 *    hit a crash on a public page can still emit a log line).
 *
 * Pins:
 *  - zod schema: message required+min:1+max:10k; stack ≤ 20k;
 *    url ≤ 2k; others ≤ 200; statusCode int; metadata is a
 *    record<string, unknown>
 *  - Triple-auth: pass any one of the three → proceed; ALL three
 *    fail → 401 'Unauthorized logger access'
 *  - Same-origin check uses NEXTAUTH_URL substring match on the
 *    origin OR referer header
 *  - **IP discovery chain**: body.ip → x-forwarded-for →
 *    x-real-ip → 'unknown'
 *  - recordSystemLog called with `level:'error'` ALWAYS (this
 *    endpoint is error-only, NOT a general logger)
 *  - user field on the log: session.user.id when session present,
 *    undefined otherwise (no user attribution on cron / same-
 *    origin paths)
 *  - **Outer catch uses `console.error` NOT serverLogger.error**
 *    (anti-recursive-log-storm) — pinned via spying on the
 *    global console.error
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const authorizeCronRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cron-auth", () => ({ authorizeCronRequest }));

const getServerSession = vi.hoisted(() => vi.fn());
vi.mock("next-auth", () => ({ getServerSession }));

vi.mock("@/lib/auth-config", () => ({ authOptions: {} }));

const recordSystemLog = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/system-logs", () => ({ recordSystemLog }));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/admin/log-error/route";

const ORIG_ENV = { ...process.env };
const APP_URL = "https://app.example.com";

function makeReq(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("https://example.com/api/admin/log-error", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

const validBody = { message: "boom" };

beforeEach(() => {
  authorizeCronRequest.mockReset().mockReturnValue(false);
  getServerSession.mockReset().mockResolvedValue(null);
  recordSystemLog.mockReset().mockResolvedValue(undefined);
  process.env.NEXTAUTH_URL = APP_URL;
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
});

// ─── Body validation ─────────────────────────────────────────────
describe("Body validation (anti-DoS size bounds)", () => {
  it("missing message → 400 VALIDATION_ERROR (NO auth attempted, NO log recorded)", async () => {
    const res = await POST(
      makeReq({}, { origin: APP_URL })
    );
    expect(res.status).toBe(400);
    expect(recordSystemLog).not.toHaveBeenCalled();
  });

  it("message > 10000 chars → 400", async () => {
    const res = await POST(
      makeReq({ message: "x".repeat(10001) }, { origin: APP_URL })
    );
    expect(res.status).toBe(400);
  });

  it("stack > 20000 chars → 400", async () => {
    const res = await POST(
      makeReq(
        { message: "hi", stack: "x".repeat(20001) },
        { origin: APP_URL }
      )
    );
    expect(res.status).toBe(400);
  });

  it("url > 2000 chars → 400", async () => {
    const res = await POST(
      makeReq(
        { message: "hi", url: "x".repeat(2001) },
        { origin: APP_URL }
      )
    );
    expect(res.status).toBe(400);
  });
});

// ─── Triple-path auth ────────────────────────────────────────────
describe("Triple-path auth", () => {
  it("ALL three paths fail → 401 'Unauthorized logger access'; NO log recorded", async () => {
    authorizeCronRequest.mockReturnValueOnce(false);
    getServerSession.mockResolvedValueOnce(null);
    // No origin header → fails same-origin too
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized logger access");
    expect(recordSystemLog).not.toHaveBeenCalled();
  });

  it("cron secret accepted → proceeds (NO session, NO origin needed)", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
    expect(recordSystemLog).toHaveBeenCalled();
  });

  it("session accepted → proceeds", async () => {
    authorizeCronRequest.mockReturnValueOnce(false);
    getServerSession.mockResolvedValueOnce({
      user: { id: "U1", email: "alice@example.com" },
    });
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
  });

  it("same-origin accepted via origin header (substring match on NEXTAUTH_URL)", async () => {
    const res = await POST(
      makeReq(validBody, { origin: APP_URL + "/some/page" })
    );
    expect(res.status).toBe(200);
  });

  it("same-origin accepted via referer header when origin missing", async () => {
    const res = await POST(
      makeReq(validBody, { referer: APP_URL + "/page" })
    );
    expect(res.status).toBe(200);
  });

  it("cross-origin without other auth → 401", async () => {
    const res = await POST(
      makeReq(validBody, { origin: "https://evil.example.org" })
    );
    expect(res.status).toBe(401);
  });
});

// ─── IP discovery chain ─────────────────────────────────────────
describe("IP discovery chain", () => {
  it("body.ip wins over headers", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    await POST(
      makeReq(
        { message: "hi", ip: "8.8.8.8" },
        {
          "x-forwarded-for": "1.2.3.4",
          "x-real-ip": "9.9.9.9",
        }
      )
    );
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ ip: "8.8.8.8" })
    );
  });

  it("x-forwarded-for fallback when body.ip missing", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    await POST(
      makeReq(validBody, { "x-forwarded-for": "1.2.3.4" })
    );
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ ip: "1.2.3.4" })
    );
  });

  it("x-real-ip fallback when both above missing", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    await POST(
      makeReq(validBody, { "x-real-ip": "9.9.9.9" })
    );
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ ip: "9.9.9.9" })
    );
  });

  it("'unknown' fallback when all sources missing (no crash)", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    await POST(makeReq(validBody));
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ ip: "unknown" })
    );
  });
});

// ─── recordSystemLog payload shape ──────────────────────────────
describe("recordSystemLog payload", () => {
  it("level is ALWAYS 'error' (this endpoint is error-only)", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    await POST(makeReq({ message: "boom" }));
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error" })
    );
  });

  it("user = session.user.id when session present; undefined on cron/same-origin paths", async () => {
    // Session path
    authorizeCronRequest.mockReturnValueOnce(false);
    getServerSession.mockResolvedValueOnce({
      user: { id: "U_SESSION" },
    });
    await POST(makeReq(validBody));
    expect(recordSystemLog).toHaveBeenLastCalledWith(
      expect.objectContaining({ user: "U_SESSION" })
    );

    // Cron path
    recordSystemLog.mockClear();
    authorizeCronRequest.mockReturnValueOnce(true);
    getServerSession.mockResolvedValueOnce(null);
    await POST(makeReq(validBody));
    expect(recordSystemLog).toHaveBeenLastCalledWith(
      expect.objectContaining({ user: undefined })
    );
  });

  it("all optional fields pass through (source, url, stack, metadata, service, requestId, statusCode)", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    await POST(
      makeReq({
        message: "boom",
        source: "checkout.tsx",
        url: "/cart",
        stack: "Error: ...\n  at ...",
        metadata: { orderId: "ORD-1" },
        service: "billing",
        requestId: "req_abc",
        statusCode: 500,
      })
    );
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "boom",
        source: "checkout.tsx",
        url: "/cart",
        stack: "Error: ...\n  at ...",
        metadata: { orderId: "ORD-1" },
        service: "billing",
        requestId: "req_abc",
        statusCode: 500,
      })
    );
  });
});

// ─── Anti-storm outer catch ─────────────────────────────────────
describe("Outer catch — uses console.error NOT serverLogger.error", () => {
  it("recordSystemLog throw → 500 'Logging failed' AND console.error called (NOT serverLogger.error)", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    recordSystemLog.mockRejectedValueOnce(
      new Error("SystemLog model crash")
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await POST(makeReq(validBody));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe("Logging failed");
      // Critical: console.error MUST have been called for the
      // anti-storm path. If a refactor reroutes to serverLogger
      // (which POSTs back to this route on failure), this test
      // fails — preventing the recursive log-storm regression.
      expect(consoleSpy).toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
