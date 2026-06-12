/**
 * Tests for `app/api/test/automation/trigger/route.ts` (slice 7hm, part 2).
 *
 * Internal QA-only endpoint to fast-forward a hosting/domain to "due now"
 * and fire the daily-scheduler with a simulated-time header. Used by the
 * test-automation harness; must NEVER reach production unless admin AND
 * the time-simulation flag is on.
 *
 * Threat model:
 *  - **Prod-side abuse**: an attacker in production could otherwise spam
 *    the daily-scheduler with arbitrary `now` values and force-eligible
 *    arbitrary services. Pinned: in NODE_ENV=production, non-admin → 401.
 *    Non-prod: open to QA.
 *  - **Disabled-time-simulation bypass**: even an admin in prod must
 *    NOT proceed when `ENABLE_TIME_SIMULATION` is off. 403.
 *  - **Service-type sniff**: a malformed `serviceType` outside the
 *    enum must NOT touch the database. Pinned via zod enum.
 *
 * Other pins:
 *  - Zod schema: serviceId/serviceType/now all optional; serviceType
 *    must be 'hosting' | 'domain' if present.
 *  - `serviceId + serviceType='hosting'` → getHostingById
 *  - `serviceId + serviceType='domain'` → getDomainById
 *  - service null → 404 NOT_FOUND
 *  - service forced eligible: `next_action_at = now-or-current`,
 *    `processing_until = null`, then save()
 *  - downstream fetch to `${NEXTAUTH_URL}/api/cron/daily-scheduler`
 *    with `x-cron-secret` + `x-simulated-time` headers
 *  - response carries `{ success, schedulerResult, simulatedTime }`
 *  - outer catch (FAMILY-QUIRK): error.message leaked into response
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const isAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ AuthService: { isAdmin } }));

const getHostingById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hostings", () => ({ getHostingById }));

const getDomainById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/domains", () => ({ getDomainById }));

const ENABLE = vi.hoisted(() => ({ value: true }));
vi.mock("@/config/automation", () => ({
  get AUTOMATION_CONFIG() {
    return { ENABLE_TIME_SIMULATION: ENABLE.value };
  },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/test/automation/trigger/route";

import { afterAll, afterEach } from "vitest";

const origFetch = globalThis.fetch;

function makeReq(body: unknown = {}) {
  return new NextRequest("https://example.com/api/test/automation/trigger", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  isAdmin.mockReset().mockResolvedValue(true);
  getHostingById.mockReset();
  getDomainById.mockReset();
  ENABLE.value = true;
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("NEXTAUTH_URL", "https://app.example.com");
  vi.stubEnv("CRON_SECRET", "cron-secret-xyz");
  globalThis.fetch = vi.fn().mockResolvedValue({
    json: vi.fn().mockResolvedValue({ ran: true }),
  } as unknown as Response);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => {
  globalThis.fetch = origFetch;
});

describe("Auth gate", () => {
  it("PROD + non-admin → 401 UNAUTHORIZED", async () => {
    vi.stubEnv("NODE_ENV", "production");
    isAdmin.mockResolvedValueOnce(false);
    const res = await POST(makeReq());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("PROD + admin → proceeds (still subject to ENABLE flag)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    isAdmin.mockResolvedValueOnce(true);
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
  });

  it("NON-PROD + non-admin → STILL proceeds (open to QA)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    isAdmin.mockResolvedValueOnce(false);
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
  });
});

describe("ENABLE_TIME_SIMULATION flag", () => {
  it("disabled → 403 DISABLED even for admin", async () => {
    ENABLE.value = false;
    isAdmin.mockResolvedValueOnce(true);
    const res = await POST(makeReq());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("DISABLED");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("Zod schema", () => {
  it("invalid serviceType → 400 (zod enum)", async () => {
    const res = await POST(makeReq({ serviceType: "bogus" }));
    expect(res.status).toBe(400);
    expect(getHostingById).not.toHaveBeenCalled();
    expect(getDomainById).not.toHaveBeenCalled();
  });

  it("empty body → 200 (all fields optional; no service mutation, fetch fires)", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(200);
    expect(getHostingById).not.toHaveBeenCalled();
    expect(getDomainById).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("Service fan-out (serviceId + serviceType)", () => {
  it("serviceType='hosting' → getHostingById; getDomainById NOT called", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    getHostingById.mockResolvedValueOnce({
      next_action_at: null,
      processing_until: new Date(),
      save,
    });
    const res = await POST(
      makeReq({ serviceId: "H1", serviceType: "hosting" })
    );
    expect(res.status).toBe(200);
    expect(getHostingById).toHaveBeenCalledWith("H1");
    expect(getDomainById).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("serviceType='domain' → getDomainById; getHostingById NOT called", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    getDomainById.mockResolvedValueOnce({
      next_action_at: null,
      processing_until: new Date(),
      save,
    });
    await POST(makeReq({ serviceId: "D1", serviceType: "domain" }));
    expect(getDomainById).toHaveBeenCalledWith("D1");
    expect(getHostingById).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("service not found → 404 NOT_FOUND; no save; no fetch", async () => {
    getHostingById.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ serviceId: "H1", serviceType: "hosting" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("forces eligibility: next_action_at = parsed `now`, processing_until = null", async () => {
    let captured: { next_action_at?: Date; processing_until?: Date | null } = {};
    const fake = {
      next_action_at: new Date("2099-12-31"),
      processing_until: new Date(),
      save: vi.fn().mockImplementation(function (this: typeof fake) {
        captured = {
          next_action_at: this.next_action_at,
          processing_until: this.processing_until,
        };
      }),
    };
    getHostingById.mockResolvedValueOnce(fake);

    await POST(
      makeReq({
        serviceId: "H1",
        serviceType: "hosting",
        now: "2026-06-12T10:00:00.000Z",
      })
    );
    expect(captured.next_action_at).toEqual(new Date("2026-06-12T10:00:00.000Z"));
    expect(captured.processing_until).toBeNull();
  });

  it("serviceId WITHOUT serviceType is a no-op for service lookup (skips the branch)", async () => {
    const res = await POST(makeReq({ serviceId: "H1" }));
    expect(res.status).toBe(200);
    expect(getHostingById).not.toHaveBeenCalled();
    expect(getDomainById).not.toHaveBeenCalled();
  });
});

describe("Downstream scheduler fetch", () => {
  it("fires GET to ${NEXTAUTH_URL}/api/cron/daily-scheduler with x-cron-secret + x-simulated-time", async () => {
    await POST(makeReq({ now: "2026-06-12T10:00:00.000Z" }));
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(url).toBe("https://app.example.com/api/cron/daily-scheduler");
    expect((opts as RequestInit).method).toBe("GET");
    const headers = (opts as RequestInit).headers as Record<string, string>;
    expect(headers["x-cron-secret"]).toBe("cron-secret-xyz");
    expect(headers["x-simulated-time"]).toBe("2026-06-12T10:00:00.000Z");
  });

  it("missing CRON_SECRET env → falls through with empty string header (NOT an outright bypass; daily-scheduler will reject)", async () => {
    vi.stubEnv("CRON_SECRET", "");
    await POST(makeReq());
    const headers = ((globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-cron-secret"]).toBe("");
  });

  it("body carries { success, schedulerResult, simulatedTime }", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      json: vi.fn().mockResolvedValue({ ran: true, processed: 7 }),
    } as unknown as Response);
    const res = await POST(makeReq({ now: "2026-06-12T10:00:00.000Z" }));
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toBe("Automation triggered");
    expect(body.schedulerResult).toEqual({ ran: true, processed: 7 });
    expect(body.simulatedTime).toBe("2026-06-12T10:00:00.000Z");
  });
});

describe("Outer catch", () => {
  it("FAMILY-QUIRK: scheduler fetch throw → 500 INTERNAL_ERROR with RAW upstream message in body (pinned alongside 7gr/7gt/7gu/7he/7hi/7hl)", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("ECONNREFUSED internal-cron-router")
    );
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL_ERROR");
    // Known leak — pin current behaviour; a future hardening pass will
    // flip this assertion deliberately.
    expect(body.error).toContain("ECONNREFUSED");
  });
});
