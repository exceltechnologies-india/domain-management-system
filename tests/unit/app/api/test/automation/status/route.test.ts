/**
 * Tests for `app/api/test/automation/status/route.ts` (slice 7hj,
 * part 2). Internal test endpoint that lets QA inspect the
 * current automation state of a hosting or domain row, optionally
 * relative to a simulated "now" (for replaying time-based logic
 * deterministically).
 *
 * Pins:
 *  - **Env-gated admin check**: in production NODE_ENV, non-admin
 *    → 401. In any other env (dev/test/staging), admin check is
 *    skipped — anonymous access allowed. Pinned because automated
 *    QA suites need to probe these endpoints without admin
 *    gymnastics.
 *  - Required query params: serviceId AND serviceType — missing
 *    either → 400 INVALID_PARAMS 'Missing parameters'
 *  - **Service-type branch**: serviceType==='hosting' calls
 *    getHostingById; anything else calls getDomainById. The
 *    `{lean: true}` option on hosting is pinned.
 *  - Service not found → 404 NOT_FOUND
 *  - **Expiry-field branch by serviceType**: hosting uses
 *    `service.expiryDate`; domain uses `service.expiresAt`. The
 *    fields have different names; the route projects the union.
 *  - No expiry → 400 NO_EXPIRY
 *  - **Simulated-now support**: `?now=2026-12-31T00:00:00.000Z`
 *    is passed to TimeService.now (overrides the real clock so
 *    daysUntil is deterministic across CI runs)
 *  - Response carries id/domainName/status/expiryDate/now/
 *    daysLeft/next_action_at/last_reminder_sent/processing_until
 *  - Outer catch → 500 INTERNAL_ERROR with error.message
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const isAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { isAdmin },
}));

const getHostingById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hostings", () => ({ getHostingById }));

const getDomainById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/domains", () => ({ getDomainById }));

const tsNow = vi.hoisted(() => vi.fn());
const tsDaysUntil = vi.hoisted(() => vi.fn());
vi.mock("@/lib/time-service", () => ({
  TimeService: { now: tsNow, daysUntil: tsDaysUntil },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/test/automation/status/route";

const ORIG_NODE_ENV = process.env.NODE_ENV;

function makeReq(qs = "") {
  const url = qs
    ? `https://example.com/api/test/automation/status?${qs}`
    : "https://example.com/api/test/automation/status";
  return new NextRequest(url, { method: "GET" });
}

beforeEach(() => {
  isAdmin.mockReset();
  getHostingById.mockReset();
  getDomainById.mockReset();
  tsNow.mockReset().mockReturnValue(new Date("2026-06-11T00:00:00.000Z"));
  tsDaysUntil.mockReset().mockReturnValue(30);
});

afterEach(() => {
  // restore NODE_ENV; some tests mutate it
  if (ORIG_NODE_ENV === undefined) {
    delete (process.env as Record<string, string | undefined>).NODE_ENV;
  } else {
    (process.env as Record<string, string>).NODE_ENV = ORIG_NODE_ENV;
  }
});

describe("Env-gated admin check", () => {
  it("in production + non-admin → 401 UNAUTHORIZED", async () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    isAdmin.mockResolvedValueOnce(false);
    const res = await GET(
      makeReq("serviceId=H1&serviceType=hosting")
    );
    expect(res.status).toBe(401);
    expect(getHostingById).not.toHaveBeenCalled();
  });

  it("in production + admin → proceeds", async () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    isAdmin.mockResolvedValueOnce(true);
    getHostingById.mockResolvedValueOnce({
      _id: "H1",
      domainName: "test.com",
      status: "active",
      expiryDate: new Date("2026-12-01"),
    });
    const res = await GET(
      makeReq("serviceId=H1&serviceType=hosting")
    );
    expect(res.status).toBe(200);
  });

  it("in non-production + non-admin → STILL proceeds (QA convenience)", async () => {
    (process.env as Record<string, string>).NODE_ENV = "development";
    isAdmin.mockResolvedValueOnce(false);
    getHostingById.mockResolvedValueOnce({
      _id: "H1",
      domainName: "test.com",
      status: "active",
      expiryDate: new Date("2026-12-01"),
    });
    const res = await GET(
      makeReq("serviceId=H1&serviceType=hosting")
    );
    expect(res.status).toBe(200);
  });
});

describe("Required query params", () => {
  beforeEach(() => {
    (process.env as Record<string, string>).NODE_ENV = "development";
  });

  it("missing serviceId → 400 INVALID_PARAMS 'Missing parameters'", async () => {
    const res = await GET(makeReq("serviceType=hosting"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_PARAMS");
    expect(getHostingById).not.toHaveBeenCalled();
  });

  it("missing serviceType → 400", async () => {
    const res = await GET(makeReq("serviceId=H1"));
    expect(res.status).toBe(400);
  });

  it("neither → 400", async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(400);
  });
});

describe("Service-type branch", () => {
  beforeEach(() => {
    (process.env as Record<string, string>).NODE_ENV = "development";
  });

  it("serviceType='hosting' → getHostingById called with {lean:true}", async () => {
    getHostingById.mockResolvedValueOnce({
      _id: "H1",
      domainName: "x.com",
      status: "active",
      expiryDate: new Date("2026-12-01"),
    });
    await GET(makeReq("serviceId=H1&serviceType=hosting"));
    expect(getHostingById).toHaveBeenCalledWith("H1", { lean: true });
    expect(getDomainById).not.toHaveBeenCalled();
  });

  it("serviceType='domain' → getDomainById called", async () => {
    getDomainById.mockResolvedValueOnce({
      _id: "D1",
      domainName: "x.com",
      status: "registered",
      expiresAt: new Date("2027-01-01"),
    });
    await GET(makeReq("serviceId=D1&serviceType=domain"));
    expect(getDomainById).toHaveBeenCalledWith("D1");
    expect(getHostingById).not.toHaveBeenCalled();
  });

  it("anything-other-than-hosting falls through to getDomainById (else branch)", async () => {
    getDomainById.mockResolvedValueOnce({
      _id: "D1",
      expiresAt: new Date("2027-01-01"),
    });
    await GET(makeReq("serviceId=D1&serviceType=garbage"));
    expect(getDomainById).toHaveBeenCalledWith("D1");
  });
});

describe("Not-found + no-expiry guards", () => {
  beforeEach(() => {
    (process.env as Record<string, string>).NODE_ENV = "development";
  });

  it("getHostingById null → 404 'Service not found' NOT_FOUND", async () => {
    getHostingById.mockResolvedValueOnce(null);
    const res = await GET(
      makeReq("serviceId=H_GHOST&serviceType=hosting")
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("hosting found but no expiryDate → 400 NO_EXPIRY 'Service has no expiry date'", async () => {
    getHostingById.mockResolvedValueOnce({
      _id: "H1",
      status: "active",
      // no expiryDate
    });
    const res = await GET(
      makeReq("serviceId=H1&serviceType=hosting")
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("NO_EXPIRY");
  });

  it("domain found but no expiresAt → 400 NO_EXPIRY", async () => {
    getDomainById.mockResolvedValueOnce({
      _id: "D1",
      status: "registered",
      // no expiresAt
    });
    const res = await GET(
      makeReq("serviceId=D1&serviceType=domain")
    );
    expect(res.status).toBe(400);
  });
});

describe("Expiry-field branch (hosting.expiryDate vs domain.expiresAt)", () => {
  beforeEach(() => {
    (process.env as Record<string, string>).NODE_ENV = "development";
  });

  it("hosting → uses service.expiryDate as the expiry source", async () => {
    const expiry = new Date("2027-03-15");
    getHostingById.mockResolvedValueOnce({
      _id: "H1",
      domainName: "alice.com",
      status: "active",
      expiryDate: expiry,
      expiresAt: new Date("2099-01-01"), // wrong field — should NOT be used
    });
    const body = await (
      await GET(makeReq("serviceId=H1&serviceType=hosting"))
    ).json();
    expect(new Date(body.data.expiryDate).toISOString()).toBe(
      expiry.toISOString()
    );
  });

  it("domain → uses service.expiresAt as the expiry source", async () => {
    const expiry = new Date("2028-09-01");
    getDomainById.mockResolvedValueOnce({
      _id: "D1",
      domainName: "alice.com",
      status: "registered",
      expiresAt: expiry,
      expiryDate: new Date("2099-01-01"), // wrong field — should NOT be used
    });
    const body = await (
      await GET(makeReq("serviceId=D1&serviceType=domain"))
    ).json();
    expect(new Date(body.data.expiryDate).toISOString()).toBe(
      expiry.toISOString()
    );
  });
});

describe("Simulated-now support (?now=)", () => {
  beforeEach(() => {
    (process.env as Record<string, string>).NODE_ENV = "development";
  });

  it("?now=<ISO> passed to TimeService.now as override", async () => {
    getHostingById.mockResolvedValueOnce({
      _id: "H1",
      expiryDate: new Date("2027-01-01"),
    });
    await GET(
      makeReq(
        "serviceId=H1&serviceType=hosting&now=2026-12-25T00:00:00.000Z"
      )
    );
    expect(tsNow).toHaveBeenCalledWith(
      null,
      "2026-12-25T00:00:00.000Z"
    );
  });

  it("?now missing → TimeService.now called with (null, undefined)", async () => {
    getHostingById.mockResolvedValueOnce({
      _id: "H1",
      expiryDate: new Date("2027-01-01"),
    });
    await GET(makeReq("serviceId=H1&serviceType=hosting"));
    expect(tsNow).toHaveBeenCalledWith(null, undefined);
  });
});

describe("Outer catch", () => {
  beforeEach(() => {
    (process.env as Record<string, string>).NODE_ENV = "development";
  });

  it("getHostingById throw → 500 INTERNAL_ERROR with error.message", async () => {
    getHostingById.mockRejectedValueOnce(new Error("Mongo timeout"));
    const res = await GET(
      makeReq("serviceId=H1&serviceType=hosting")
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL_ERROR");
  });
});
