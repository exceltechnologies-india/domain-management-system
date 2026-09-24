import { describe, it, expect, vi, beforeEach } from "vitest";

const findPriorTrial = vi.hoisted(() => vi.fn());
const recordExternalTrial = vi.hoisted(() => vi.fn());
vi.mock("@/lib/trials/trial-history", () => ({ findPriorTrial, recordExternalTrial }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimiters: { engineRead: { isAllowed: async () => ({ allowed: true }) } },
  rateLimitResponse: () => new Response(null, { status: 429 }),
}));
vi.mock("@/lib/server-logger", () => ({ serverLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

// DMS mocks next/server globally; this route needs the real request and response.
vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<typeof import("next/server")>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

const { GET, POST } = await import("@/app/api/integrations/engine/trials/route");

const READ = "read-key-test-0123456789";
const CMD = "cmd-key-test-0123456789";
const get = (qs: string, key = READ) =>
  new NextRequest(`https://dms.example.invalid/api/integrations/engine/trials?${qs}`, { headers: { "x-integration-key": key } });
const post = (body: unknown, key = CMD) =>
  new NextRequest("https://dms.example.invalid/api/integrations/engine/trials", {
    method: "POST",
    headers: { "x-integration-key": key, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  process.env.ENGINE_READ_API_KEY = READ;
  process.env.BILLING_COMMAND_API_KEY = CMD;
  findPriorTrial.mockReset().mockResolvedValue({ found: false });
  recordExternalTrial.mockReset().mockResolvedValue({ created: true });
});

describe("GET — has this customer had a trial in either app?", () => {
  it("needs the read key", async () => {
    expect((await GET(get("email=a@b.in", "wrong"))).status).toBe(401);
  });

  it("answers trialled with where and when", async () => {
    findPriorTrial.mockResolvedValueOnce({ found: true, where: "dms", startedAt: new Date("2026-09-01T00:00:00Z") });
    const body = await (await GET(get("email=a@b.in&phone=9876543210&domain=acme.in"))).json();
    expect(body).toEqual({ trialled: true, where: "dms", startedAt: "2026-09-01T00:00:00.000Z" });
    expect(findPriorTrial).toHaveBeenCalledWith({ email: "a@b.in", phone: "9876543210", domain: "acme.in" });
  });

  it("a lookup failure is a 500, never trialled:false", async () => {
    findPriorTrial.mockRejectedValueOnce(new Error("mongo down"));
    const res = await GET(get("email=a@b.in"));
    expect(res.status).toBe(500);
    expect((await res.json()).trialled).toBeUndefined();
  });

  it("no key at all → 400", async () => {
    expect((await GET(get(""))).status).toBe(400);
  });
});

describe("POST — record a trial ResellerOS started", () => {
  it("needs the COMMAND key: the read key cannot write", async () => {
    expect((await POST(post({ ref: "L-1", email: "a@b.in" }, READ))).status).toBe(401);
  });

  it("records it", async () => {
    const res = await POST(post({ ref: "L-1", email: "a@b.in", domain: "acme.in", cycle: "yearly" }));
    expect(await res.json()).toEqual({ recorded: true, created: true });
    expect(recordExternalTrial).toHaveBeenCalledWith(expect.objectContaining({ ref: "L-1", email: "a@b.in" }));
  });

  it("rejects a bad body", async () => {
    expect((await POST(post({ email: "not-an-email" }))).status).toBe(400);
  });
});
