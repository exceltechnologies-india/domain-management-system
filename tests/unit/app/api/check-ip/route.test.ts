/**
 * Tests for `app/api/check-ip/route.ts` (slice 7hn, part 2).
 *
 * Public diagnostic endpoint used by ops to confirm Cloud Run's outbound
 * NAT IP — the DA-whitelist setup depends on this number being stable
 * (see `project_da_whitelist_layers` auto-memory: 34.14.59.128).
 *
 * Threat model:
 *  - **Single-service outage masking real outbound IP**: if one of the
 *    4 lookup services goes down, the route MUST still return a useful
 *    answer from the survivors. Pinned: per-service try/catch.
 *  - **Server-info echo leaking internal fields**: response carries
 *    user-agent + host + x-forwarded-for + x-real-ip. Pinned shape so
 *    a refactor doesn't widen the echo (no environment vars, no
 *    auth cookies, etc.).
 *
 * Other pins:
 *  - Calls the 4 hard-coded services: api.ipify.org (plain), ipinfo.io,
 *    api.ipify.org?format=json, httpbin.org/ip
 *  - JSON-vs-text response handling: ?format=json + httpbin parsed,
 *    others kept as plain text
 *  - Per-service failure isolation: results.services[svc] records
 *    {status:'error', error, responseTime}
 *  - HTTP-not-ok captured the same way (status:'error' with HTTP-N
 *    error string)
 *  - allIPs deduplicated; primaryIP = most-frequent (mode)
 *  - serverInfo: { userAgent, host, forwarded, realIP } from headers
 *  - Outer catch → 500 with raw error message in body (FAMILY-QUIRK
 *    leak — pinned alongside the existing family)
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/check-ip/route";

const origFetch = globalThis.fetch;

function makeReq(headers: Record<string, string> = {}) {
  return new NextRequest("https://example.com/api/check-ip", {
    method: "GET",
    headers,
  });
}

function makeFetchResponse(
  body: string,
  opts: { ok?: boolean; status?: number; headerResponseTime?: string } = {}
) {
  const { ok = true, status = 200, headerResponseTime } = opts;
  const headers = new Map<string, string>();
  if (headerResponseTime) headers.set("x-response-time", headerResponseTime);
  return {
    ok,
    status,
    text: vi.fn().mockResolvedValue(body),
    headers: {
      get: (k: string) => headers.get(k.toLowerCase()) ?? null,
    },
  } as unknown as Response;
}

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterAll(() => {
  globalThis.fetch = origFetch;
});

describe("4-service fan-out", () => {
  it("fires GET to all 4 services in order with the project User-Agent", async () => {
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
    expect((calls[0][1] as RequestInit).headers).toEqual({
      "User-Agent": "Domain-Management-System/1.0",
    });
  });
});

describe("JSON-vs-text response parsing", () => {
  it("plain-text service: ip kept verbatim", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeFetchResponse("1.2.3.4"))
      .mockResolvedValueOnce(makeFetchResponse("5.6.7.8"))
      .mockResolvedValueOnce(makeFetchResponse('{"ip":"9.9.9.9"}'))
      .mockResolvedValueOnce(makeFetchResponse('{"origin":"1.2.3.4"}'));
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data.services["https://api.ipify.org"].ip).toBe("1.2.3.4");
    expect(body.data.services["https://ipinfo.io/ip"].ip).toBe("5.6.7.8");
  });

  it("?format=json: parses jsonData.ip", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeFetchResponse("1.2.3.4"))
      .mockResolvedValueOnce(makeFetchResponse("1.2.3.4"))
      .mockResolvedValueOnce(makeFetchResponse('{"ip":"9.9.9.9"}'))
      .mockResolvedValueOnce(makeFetchResponse('{"origin":"1.2.3.4"}'));
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data.services["https://api.ipify.org?format=json"].ip).toBe(
      "9.9.9.9"
    );
  });

  it("httpbin: parses jsonData.origin", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeFetchResponse("1.2.3.4"))
      .mockResolvedValueOnce(makeFetchResponse("1.2.3.4"))
      .mockResolvedValueOnce(makeFetchResponse('{"ip":"9.9.9.9"}'))
      .mockResolvedValueOnce(makeFetchResponse('{"origin":"7.7.7.7"}'));
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data.services["https://httpbin.org/ip"].ip).toBe("7.7.7.7");
  });

  it("?format=json with unparseable body falls back to raw text", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeFetchResponse("1.2.3.4"))
      .mockResolvedValueOnce(makeFetchResponse("1.2.3.4"))
      .mockResolvedValueOnce(makeFetchResponse("not-json-at-all"))
      .mockResolvedValueOnce(makeFetchResponse('{"origin":"7.7.7.7"}'));
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data.services["https://api.ipify.org?format=json"].ip).toBe(
      "not-json-at-all"
    );
  });
});

describe("Per-service failure isolation", () => {
  it("one throw + one HTTP-error → other 2 still report success", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("ECONNREFUSED ipify"))
      .mockResolvedValueOnce(
        makeFetchResponse("forbidden", { ok: false, status: 403 })
      )
      .mockResolvedValueOnce(makeFetchResponse('{"ip":"9.9.9.9"}'))
      .mockResolvedValueOnce(makeFetchResponse('{"origin":"9.9.9.9"}'));

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.services["https://api.ipify.org"].status).toBe("error");
    expect(body.data.services["https://api.ipify.org"].error).toBe(
      "ECONNREFUSED ipify"
    );
    expect(body.data.services["https://ipinfo.io/ip"].status).toBe("error");
    expect(body.data.services["https://ipinfo.io/ip"].error).toBe("HTTP 403");
    expect(
      body.data.services["https://api.ipify.org?format=json"].status
    ).toBe("success");
    expect(body.data.services["https://httpbin.org/ip"].status).toBe(
      "success"
    );
  });

  it("ALL 4 services fail → 200 with primaryIP=null, allIPs=[]", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("network down")
    );
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.primaryIP).toBeNull();
    expect(body.data.allIPs).toEqual([]);
  });
});

describe("Most-common-IP voting (KNOWN QUIRK)", () => {
  it("dedup happens BEFORE the count → voting picks last-distinct-IP, not actual mode", async () => {
    // FAMILY-QUIRK: the route dedups into `allIPs` first, then runs a
    // "most common" reduce — but every entry in the deduped list has
    // count 1, so the reduce is effectively "last distinct IP seen".
    // 3 services voting 9.9.9.9 + 1 voting 1.1.1.1 → 1.1.1.1 wins.
    //
    // Pinned at current behaviour because the diagnostic's purpose
    // (ops checking Cloud Run NAT IP — see `project_da_whitelist_layers`)
    // is well-served by the single returned IP under any normal
    // deployment where all services agree. Future hardening to actually
    // count pre-dedup would flip this assertion deliberately.
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeFetchResponse("9.9.9.9"))
      .mockResolvedValueOnce(makeFetchResponse("9.9.9.9"))
      .mockResolvedValueOnce(makeFetchResponse('{"ip":"9.9.9.9"}'))
      .mockResolvedValueOnce(makeFetchResponse('{"origin":"1.1.1.1"}'));
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data.primaryIP).toBe("1.1.1.1");
    // dedup pinned
    expect(body.data.allIPs.sort()).toEqual(["1.1.1.1", "9.9.9.9"]);
  });

  it("all 4 services agree → primaryIP is that single value", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeFetchResponse("34.14.59.128"))
      .mockResolvedValueOnce(makeFetchResponse("34.14.59.128"))
      .mockResolvedValueOnce(makeFetchResponse('{"ip":"34.14.59.128"}'))
      .mockResolvedValueOnce(makeFetchResponse('{"origin":"34.14.59.128"}'));
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data.primaryIP).toBe("34.14.59.128");
    expect(body.data.allIPs).toEqual(["34.14.59.128"]);
  });
});

describe("Server-info echo (anti-widening guard)", () => {
  it("carries ONLY the 4 expected fields: userAgent, host, forwarded, realIP", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFetchResponse("1.2.3.4")
    );
    const res = await GET(
      makeReq({
        "user-agent": "curl/8.0",
        host: "app.anutech.in",
        "x-forwarded-for": "10.0.0.1",
        "x-real-ip": "10.0.0.2",
        // Sentinels — must NOT appear in the response.
        cookie: "session=zoho_oauth_LEAK_ME_PLEASE",
        authorization: "Bearer apk_LEAK_ME",
      })
    );
    const body = await res.json();
    expect(Object.keys(body.data.serverInfo).sort()).toEqual([
      "forwarded",
      "host",
      "realIP",
      "userAgent",
    ]);
    expect(body.data.serverInfo.userAgent).toBe("curl/8.0");
    expect(body.data.serverInfo.host).toBe("app.anutech.in");
    expect(body.data.serverInfo.forwarded).toBe("10.0.0.1");
    expect(body.data.serverInfo.realIP).toBe("10.0.0.2");
    // Negative leak guard
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("zoho_oauth_LEAK_ME_PLEASE");
    expect(raw).not.toContain("apk_LEAK_ME");
  });
});

describe("Response shape", () => {
  it("returns { success, message, data: { timestamp, services, primaryIP, allIPs, serverInfo } }", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeFetchResponse("1.2.3.4")
    );
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toBe("Outbound IP check completed");
    expect(body.data).toEqual(
      expect.objectContaining({
        timestamp: expect.any(String),
        services: expect.any(Object),
        primaryIP: expect.any(String),
        allIPs: expect.any(Array),
        serverInfo: expect.any(Object),
      })
    );
  });
});
