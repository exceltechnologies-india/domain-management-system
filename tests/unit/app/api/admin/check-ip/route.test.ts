/**
 * Tests for `app/api/admin/check-ip/route.ts` (slice 7hz, part 1).
 *
 * Admin variant of the outbound-IP diagnostic. Same 4-service probe
 * as the public check-ip (tested in slice 7hn), but **with an audit
 * trail** — every check is persisted to the IPCheck collection with
 * the admin's user ID.
 *
 * Threat model:
 *  - **Anonymous IP-check log spam**: a refactor that drops the
 *    admin gate would let anyone fill the IPCheck collection with
 *    junk records. Pinned: 401 before any probe, NO recordIPCheck
 *    call.
 *  - **Failed-probe DB schema crash**: `primaryIP` is non-null in
 *    the IPCheck schema, but the in-route state has it as
 *    `string|null`. The boundary coerce (`?? ''`) prevents a
 *    crash when all 4 services fail. Pinned with all-fail probe.
 *
 * Other pins:
 *  - Admin gate → 401; NO probe, NO recordIPCheck
 *  - At least 1 service success → response data block populated;
 *    success:true; message includes the primaryIP
 *  - All 4 services fail → success:false; data:undefined;
 *    error:"All IP detection services failed"; recordIPCheck STILL
 *    called (audit-trail intent — admin needs to see the failure)
 *  - recordIPCheck called with checkedBy=admin._id
 *  - serverInfo:undefined coerce for null headers (host/forwarded
 *    /real-ip absent in request)
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const recordIPCheck = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/ip-checks", () => ({ recordIPCheck }));

vi.mock("@/lib/mongodb", () => ({
  default: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/admin/check-ip/route";

const origFetch = globalThis.fetch;

function makeReq(headers: Record<string, string> = {}) {
  return new NextRequest("https://example.com/api/admin/check-ip", {
    method: "GET",
    headers,
  });
}

function makeFetchResponse(
  body: string,
  opts: { ok?: boolean; status?: number } = {}
) {
  const { ok = true, status = 200 } = opts;
  return {
    ok,
    status,
    text: vi.fn().mockResolvedValue(body),
    headers: { get: () => null },
  } as unknown as Response;
}

beforeEach(() => {
  getAdminFromRequest.mockReset().mockResolvedValue({
    _id: "ADMIN1",
    email: "admin@example.com",
  });
  recordIPCheck.mockReset().mockResolvedValue(undefined);
  globalThis.fetch = vi.fn();
});

afterAll(() => {
  globalThis.fetch = origFetch;
});

describe("Admin gate", () => {
  it("non-admin → 401; NO probe; NO recordIPCheck", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(recordIPCheck).not.toHaveBeenCalled();
  });
});

describe("4-service probe ordering", () => {
  it("fires GET to all 4 services in pinned order", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFetchResponse("1.2.3.4")
    );
    await GET(makeReq());
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(4);
    expect(calls[0][0]).toBe("https://api.ipify.org");
    expect(calls[1][0]).toBe("https://ipinfo.io/ip");
    expect(calls[2][0]).toBe("https://api.ipify.org?format=json");
    expect(calls[3][0]).toBe("https://httpbin.org/ip");
  });
});

describe("Happy path — at least 1 success", () => {
  it("all 4 succeed → success:true; data populated; message includes primaryIP", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeFetchResponse("34.14.59.128"))
      .mockResolvedValueOnce(makeFetchResponse("34.14.59.128"))
      .mockResolvedValueOnce(makeFetchResponse('{"ip":"34.14.59.128"}'))
      .mockResolvedValueOnce(makeFetchResponse('{"origin":"34.14.59.128"}'));
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toContain("34.14.59.128");
    expect(body.data).toBeDefined();
    expect(body.data.primaryIP).toBe("34.14.59.128");
  });

  it("1 of 4 succeeds → success:true; data still populated", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValueOnce(makeFetchResponse('{"ip":"34.14.59.128"}'))
      .mockRejectedValueOnce(new Error("fail 4"));
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
    expect(body.data.services["https://api.ipify.org"].status).toBe("error");
  });
});

describe("All-fail path", () => {
  it("all 4 fail → success:false; data:undefined; error message; recordIPCheck STILL called (audit-trail)", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("network down")
    );
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.data).toBeUndefined();
    expect(body.error).toBe("All IP detection services failed");
    // CRITICAL: even on full failure, recordIPCheck is still called
    expect(recordIPCheck).toHaveBeenCalledTimes(1);
  });

  it("all 4 return HTTP errors (not throws) → success:false", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFetchResponse("err", { ok: false, status: 503 })
    );
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});

describe("DB-record audit trail", () => {
  it("recordIPCheck called with checkedBy=admin._id + message + success flag", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFetchResponse("34.14.59.128")
    );
    await GET(makeReq());
    expect(recordIPCheck).toHaveBeenCalledTimes(1);
    const arg = recordIPCheck.mock.calls[0][0];
    expect(arg).toEqual(
      expect.objectContaining({
        success: true,
        checkedBy: "ADMIN1",
      })
    );
    expect(arg.message).toContain("34.14.59.128");
  });

  it("**SCHEMA-BOUNDARY COERCE: all-fail → primaryIP coerced to '' (not null) for the DB record**", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("all fail")
    );
    await GET(makeReq());
    const arg = recordIPCheck.mock.calls[0][0];
    expect(arg.data.primaryIP).toBe("");
  });

  it("serverInfo headers absent → undefined (not null) in DB record", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFetchResponse("1.2.3.4")
    );
    await GET(makeReq());
    const arg = recordIPCheck.mock.calls[0][0];
    expect(arg.data.serverInfo.host).toBeUndefined();
    expect(arg.data.serverInfo.forwarded).toBeUndefined();
    expect(arg.data.serverInfo.realIP).toBeUndefined();
  });

  it("serverInfo headers present → pass through verbatim", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFetchResponse("1.2.3.4")
    );
    await GET(
      makeReq({
        host: "admin.example.com",
        "x-forwarded-for": "10.0.0.1",
        "x-real-ip": "10.0.0.2",
      })
    );
    const arg = recordIPCheck.mock.calls[0][0];
    expect(arg.data.serverInfo.host).toBe("admin.example.com");
    expect(arg.data.serverInfo.forwarded).toBe("10.0.0.1");
    expect(arg.data.serverInfo.realIP).toBe("10.0.0.2");
  });
});

describe("Outer catch", () => {
  it("recordIPCheck throw → 500 generic", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFetchResponse("1.2.3.4")
    );
    recordIPCheck.mockRejectedValueOnce(new Error("Mongo down"));
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("Internal server error");
  });
});
