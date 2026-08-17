/**
 * Tests for `app/api/admin/resellers/route.ts` (sub-reseller Phase 1).
 * Pins: feature-flag gate (404 when off), admin gate (401), list + create
 * happy paths, and ResellerError → mapped status (409 duplicate email).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ AuthService: { getAdminFromRequest } }));

const flagMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/reseller-flag", () => ({ isResellerFeatureEnabled: flagMock }));

const listResellers = vi.hoisted(() => vi.fn());
const createReseller = vi.hoisted(() => vi.fn());
// Real ResellerError so `instanceof` in the route matches.
class ResellerError extends Error {
  code: string; status: number;
  constructor(m: string, c: string, s = 400) { super(m); this.code = c; this.status = s; }
}
vi.mock("@/lib/services/resellers", () => ({ listResellers, createReseller, ResellerError }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

const { GET, POST } = await import("@/app/api/admin/resellers/route");

function makeReq(method: "GET" | "POST", body?: unknown) {
  return new NextRequest("https://example.com/api/admin/resellers", {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
  });
}
const ADMIN = { _id: { toString: () => "admin1" } };

beforeEach(() => {
  vi.clearAllMocks();
  flagMock.mockReturnValue(true);
  getAdminFromRequest.mockResolvedValue(ADMIN);
});

describe("feature flag", () => {
  it("GET → 404 when the feature is disabled", async () => {
    flagMock.mockReturnValue(false);
    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(404);
    expect(getAdminFromRequest).not.toHaveBeenCalled();
  });
  it("POST → 404 when the feature is disabled", async () => {
    flagMock.mockReturnValue(false);
    const res = await POST(makeReq("POST", { email: "a@b.com", businessName: "X" }));
    expect(res.status).toBe(404);
  });
});

describe("admin gate", () => {
  it("GET → 401 for non-admin", async () => {
    getAdminFromRequest.mockResolvedValue(null);
    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(401);
    expect(listResellers).not.toHaveBeenCalled();
  });
  it("POST → 401 for non-admin", async () => {
    getAdminFromRequest.mockResolvedValue(null);
    const res = await POST(makeReq("POST", { email: "a@b.com", businessName: "Acme" }));
    expect(res.status).toBe(401);
    expect(createReseller).not.toHaveBeenCalled();
  });
});

describe("GET list", () => {
  it("returns resellers", async () => {
    listResellers.mockResolvedValue([{ _id: "r1", businessName: "Acme" }]);
    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.resellers).toHaveLength(1);
  });
});

describe("POST create", () => {
  it("201 on success", async () => {
    createReseller.mockResolvedValue({ _id: "r1", businessName: "Acme", status: "pending" });
    const res = await POST(makeReq("POST", { email: "owner@acme.com", businessName: "Acme" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.reseller.status).toBe("pending");
    expect(createReseller).toHaveBeenCalledWith(
      expect.objectContaining({ email: "owner@acme.com", businessName: "Acme" }),
      "admin1"
    );
  });

  it("400 on invalid body (bad email)", async () => {
    const res = await POST(makeReq("POST", { email: "not-an-email", businessName: "Acme" }));
    expect(res.status).toBe(400);
    expect(createReseller).not.toHaveBeenCalled();
  });

  it("maps ResellerError(EMAIL_IN_USE) to 409", async () => {
    createReseller.mockRejectedValue(new ResellerError("dupe", "EMAIL_IN_USE", 409));
    const res = await POST(makeReq("POST", { email: "dupe@acme.com", businessName: "Acme" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("EMAIL_IN_USE");
  });
});
