/**
 * Tests for `app/api/admin/domains/sync/route.ts` (slice 7gx, part
 * 2). Admin triggers a registrar sync for one domain OR a batch
 * of up to 100. The batch path inserts a 500ms pause between
 * calls so the registrar's rate limiter doesn't bite.
 *
 * Pins:
 *  - connectDB BEFORE auth (current source order)
 *  - Admin gate via getAdminFromRequest → 401
 *  - zod schema: domainName trim+lowercase+3-253 OR domainNames
 *    array of those, min 1, **max 100** (anti-DoS cap pinned)
 *  - Refine: at least one of (domainName | domainNames) required
 *  - **Single-domain path**: syncDomainWithRegistrar called once
 *    with the lowercased+trimmed name; result returned verbatim
 *    (NOT wrapped in {success, results})
 *  - **Batch path**: zod refine guarantees domainNames is present;
 *    each entry processed sequentially with **500ms delay
 *    between** (rate-limit defence, pinned via fake timers); the
 *    response IS wrapped as `{success:true, results:[...]}`
 *  - Outer catch → 500 'Failed to sync domain registrar
 *    information'
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const connectDB = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

const syncDomainWithRegistrar = vi.hoisted(() => vi.fn());
vi.mock("@/lib/domain-verification", () => ({
  DomainVerificationService: { syncDomainWithRegistrar },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/admin/domains/sync/route";

function makeReq(body: unknown) {
  return new NextRequest("https://example.com/api/admin/domains/sync", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  getAdminFromRequest.mockReset();
  connectDB.mockClear().mockResolvedValue(undefined);
  syncDomainWithRegistrar.mockReset();
});

describe("Admin gate", () => {
  it("non-admin → 401 'Unauthorized'; NO sync call", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ domainName: "example.com" }));
    expect(res.status).toBe(401);
    expect(syncDomainWithRegistrar).not.toHaveBeenCalled();
  });
});

describe("Body validation", () => {
  beforeEach(() => {
    getAdminFromRequest.mockResolvedValue({ _id: "A1" });
  });

  it("neither domainName nor domainNames → 400 (refine 'Either domainName or domainNames')", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    expect(syncDomainWithRegistrar).not.toHaveBeenCalled();
  });

  it("invalid domainName format → 400", async () => {
    const res = await POST(makeReq({ domainName: "ab" })); // < 3 chars
    expect(res.status).toBe(400);
  });

  it("domainNames empty array → 400 (min:1)", async () => {
    const res = await POST(makeReq({ domainNames: [] }));
    expect(res.status).toBe(400);
  });

  it("domainNames length > 100 → 400 (anti-DoS cap)", async () => {
    const big = Array.from({ length: 101 }, (_, i) => `d${i}.com`);
    const res = await POST(makeReq({ domainNames: big }));
    expect(res.status).toBe(400);
    expect(syncDomainWithRegistrar).not.toHaveBeenCalled();
  });

  it("domainNames length === 100 → accepted (boundary)", async () => {
    const onehundred = Array.from(
      { length: 100 },
      (_, i) => `d${i}.com`
    );
    syncDomainWithRegistrar.mockResolvedValue({ ok: true });
    // Disable real timers so we don't wait 50s for 100 × 500ms
    vi.useFakeTimers();
    const promise = POST(makeReq({ domainNames: onehundred }));
    await vi.runAllTimersAsync();
    const res = await promise;
    vi.useRealTimers();
    expect(res.status).toBe(200);
    expect(syncDomainWithRegistrar).toHaveBeenCalledTimes(100);
  });
});

describe("Single-domain path", () => {
  it("calls syncDomainWithRegistrar once with lowercased+trimmed name; result returned verbatim (NOT wrapped)", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    syncDomainWithRegistrar.mockResolvedValueOnce({
      success: true,
      registrar: "RC",
      expiry: "2027-01-01",
    });

    const res = await POST(
      makeReq({ domainName: "  EXAMPLE.COM  " })
    );
    expect(res.status).toBe(200);
    expect(syncDomainWithRegistrar).toHaveBeenCalledTimes(1);
    expect(syncDomainWithRegistrar).toHaveBeenCalledWith("example.com");

    const body = await res.json();
    // Verbatim, no `success`/`results` wrapper
    expect(body).toEqual({
      success: true,
      registrar: "RC",
      expiry: "2027-01-01",
    });
    // Specifically NOT a batch-wrapped shape
    expect(body).not.toHaveProperty("results");
  });
});

describe("Batch path — 500ms delay between calls (rate-limit defence)", () => {
  it("inserts 500ms between calls; response wrapped as {success:true, results:[...]}", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    syncDomainWithRegistrar
      .mockResolvedValueOnce({ name: "a.com", ok: true })
      .mockResolvedValueOnce({ name: "b.com", ok: true })
      .mockResolvedValueOnce({ name: "c.com", ok: false, error: "rate limited" });

    vi.useFakeTimers();
    const promise = POST(
      makeReq({ domainNames: ["A.COM", "B.COM", "C.COM"] })
    );

    // Drive the entire pipeline (3 setTimeout(500) gaps + 3 service calls)
    await vi.runAllTimersAsync();
    const res = await promise;
    vi.useRealTimers();

    expect(res.status).toBe(200);
    expect(syncDomainWithRegistrar).toHaveBeenCalledTimes(3);
    // Names lowercased via the schema before reaching the service
    expect(syncDomainWithRegistrar).toHaveBeenNthCalledWith(1, "a.com");
    expect(syncDomainWithRegistrar).toHaveBeenNthCalledWith(2, "b.com");
    expect(syncDomainWithRegistrar).toHaveBeenNthCalledWith(3, "c.com");

    const body = await res.json();
    expect(body).toEqual({
      success: true,
      results: [
        { name: "a.com", ok: true },
        { name: "b.com", ok: true },
        { name: "c.com", ok: false, error: "rate limited" },
      ],
    });
  });

  it("setTimeout(500) actually fires before each sync — fake timer confirms the pause", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    syncDomainWithRegistrar.mockResolvedValue({ ok: true });

    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const promise = POST(makeReq({ domainNames: ["a.com", "b.com"] }));
    await vi.runAllTimersAsync();
    await promise;
    vi.useRealTimers();

    // 2 calls of setTimeout(_, 500) for the 2 domains
    const fiveHundredMsCalls = setTimeoutSpy.mock.calls.filter(
      (c) => c[1] === 500
    );
    expect(fiveHundredMsCalls.length).toBe(2);
    setTimeoutSpy.mockRestore();
  });
});

describe("Outer catch", () => {
  it("sync throw → 500 'Failed to sync domain registrar information'", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    syncDomainWithRegistrar.mockRejectedValueOnce(
      new Error("RC api-key=apk_LEAK invalid")
    );
    const res = await POST(makeReq({ domainName: "example.com" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe(
      "Failed to sync domain registrar information"
    );
    expect(body.error).not.toContain("apk_LEAK");
    expect(body.error).not.toContain("api-key");
  });
});
