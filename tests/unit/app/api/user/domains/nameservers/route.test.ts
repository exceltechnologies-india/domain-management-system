/**
 * Tests for `app/api/user/domains/nameservers/route.ts` (slice 7ge).
 * Customer-facing nameserver update endpoint. The big risk class
 * here is IDOR: a customer must NOT be able to change nameservers
 * on a domain that belongs to someone else, even if they know its
 * resellerClubOrderId.
 *
 * Pins:
 *  - **Auth**: AuthService first, then next-auth JWT fallback;
 *    neither present → 401 (so JWT-only mobile clients still work)
 *  - **Body validation** via zod — bad domain regex / bad
 *    nameserver regex / method enum / fewer than 2 nameservers →
 *    400 VALIDATION_ERROR (registrar API rejects bad NS but pre-
 *    validating keeps us from leaking RC errors to clients)
 *  - **Method enforcement**: method='custom' but no nameservers /
 *    nameservers.length < 2 → 400 (registrars require ≥2 NS)
 *  - **Ownership check** — findOrderByDomainForUser(user._id,
 *    domainName) must return non-null. Note the message is
 *    intentionally ambiguous ("Domain not found or unauthorized"
 *    — 404) so the endpoint can't be used to enumerate which
 *    domains exist
 *  - **Order has domain but findOrderDomain returns null** → 404
 *    'Domain not found in order' (defensive — protects against a
 *    stale order index that doesn't actually contain the domain)
 *  - **Missing resellerClubOrderId** → 400 'missing its
 *    registrar order reference' (prevents passing undefined to
 *    the RC SDK)
 *  - **Default method**: setDefaultNameservers called with the
 *    resellerClubOrderId; setCustom NOT called
 *  - **Custom method**: setCustomNameservers called with the
 *    resellerClubOrderId + lowercased trimmed nameservers (zod
 *    schema normalises)
 *  - **RC failure (status !== 'success')**: 500 + the RC message
 *    surfaced (so user sees real reason like 'invalid host')
 *  - **Outer catch**: 500 generic 'Failed to update nameservers'
 *    (no RC internals leaked)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const getToken = vi.hoisted(() => vi.fn());
vi.mock("next-auth/jwt", () => ({ getToken }));

vi.mock("@/lib/auth-secret", () => ({ AUTH_SECRET: "test-secret" }));

const findOrderByDomainForUser = vi.hoisted(() => vi.fn());
const findOrderDomain = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  findOrderByDomainForUser,
  findOrderDomain,
}));

const setDefaultNameservers = vi.hoisted(() => vi.fn());
const setCustomNameservers = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub-wrapper", () => ({
  ResellerClubWrapper: { setDefaultNameservers, setCustomNameservers },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/user/domains/nameservers/route";

function makeReq(body: unknown) {
  return new NextRequest("https://example.com/api/user/domains/nameservers", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const user = { _id: "U1", role: "user" };

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(user);
  getToken.mockReset();
  findOrderByDomainForUser.mockReset();
  findOrderDomain.mockReset();
  setDefaultNameservers.mockReset();
  setCustomNameservers.mockReset();
});

// ─── Auth ─────────────────────────────────────────────────────────
describe("Auth (AuthService + JWT fallback)", () => {
  it("no AuthService user, no JWT → 401", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    getToken.mockResolvedValueOnce(null);
    const res = await POST(
      makeReq({ domainName: "example.com", method: "default" })
    );
    expect(res.status).toBe(401);
  });

  it("AuthService null but JWT present → proceeds (JWT-only path)", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    getToken.mockResolvedValueOnce({ id: "U-JWT", role: "user" });
    findOrderByDomainForUser.mockResolvedValueOnce({
      _id: "O1",
      domain: { name: "example.com" },
    });
    findOrderDomain.mockReturnValueOnce({
      name: "example.com",
      resellerClubOrderId: "RC-1",
    });
    setDefaultNameservers.mockResolvedValueOnce({ status: "success" });

    const res = await POST(
      makeReq({ domainName: "example.com", method: "default" })
    );
    expect(res.status).toBe(200);
    expect(findOrderByDomainForUser).toHaveBeenCalledWith("U-JWT", "example.com");
  });
});

// ─── Body validation ─────────────────────────────────────────────
describe("Body validation", () => {
  it("invalid domain format → 400 VALIDATION_ERROR", async () => {
    const res = await POST(makeReq({ domainName: "bad!", method: "default" }));
    expect(res.status).toBe(400);
  });

  it("invalid method → 400", async () => {
    const res = await POST(
      makeReq({ domainName: "example.com", method: "fancy" })
    );
    expect(res.status).toBe(400);
  });

  it("custom method with only 1 nameserver → 400 (registrars require ≥2)", async () => {
    const res = await POST(
      makeReq({
        domainName: "example.com",
        method: "custom",
        nameservers: ["ns1.example.com"],
      })
    );
    expect(res.status).toBe(400);
  });

  it("custom method with no nameservers field → 400", async () => {
    const res = await POST(
      makeReq({ domainName: "example.com", method: "custom" })
    );
    expect(res.status).toBe(400);
  });

  it("custom method with malformed nameserver → 400", async () => {
    const res = await POST(
      makeReq({
        domainName: "example.com",
        method: "custom",
        nameservers: ["ns1", "ns2.com"],
      })
    );
    expect(res.status).toBe(400);
  });
});

// ─── Ownership / IDOR guard ──────────────────────────────────────
describe("Ownership check (IDOR guard)", () => {
  it("findOrderByDomainForUser returns null → 404 ambiguous message (anti-enumeration)", async () => {
    findOrderByDomainForUser.mockResolvedValueOnce(null);
    const res = await POST(
      makeReq({ domainName: "stranger-owned.com", method: "default" })
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Domain not found or unauthorized");
    expect(setDefaultNameservers).not.toHaveBeenCalled();
    expect(setCustomNameservers).not.toHaveBeenCalled();
  });

  it("Ownership query keyed on the requesting user._id (NOT on submitted domain only)", async () => {
    findOrderByDomainForUser.mockResolvedValueOnce(null);
    await POST(
      makeReq({ domainName: "example.com", method: "default" })
    );
    expect(findOrderByDomainForUser).toHaveBeenCalledWith("U1", "example.com");
  });

  it("order found but findOrderDomain returns null → 404 'Domain not found in order'", async () => {
    findOrderByDomainForUser.mockResolvedValueOnce({ _id: "O1" });
    findOrderDomain.mockReturnValueOnce(null);
    const res = await POST(
      makeReq({ domainName: "example.com", method: "default" })
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Domain not found in order");
    expect(setDefaultNameservers).not.toHaveBeenCalled();
  });

  it("missing resellerClubOrderId → 400 'missing its registrar order reference'", async () => {
    findOrderByDomainForUser.mockResolvedValueOnce({ _id: "O1" });
    findOrderDomain.mockReturnValueOnce({
      name: "example.com",
      resellerClubOrderId: undefined,
    });
    const res = await POST(
      makeReq({ domainName: "example.com", method: "default" })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("missing its registrar order reference");
  });
});

// ─── Default method ───────────────────────────────────────────────
describe("Default method", () => {
  it("calls setDefaultNameservers with the resellerClubOrderId; setCustom NOT called", async () => {
    findOrderByDomainForUser.mockResolvedValueOnce({ _id: "O1" });
    findOrderDomain.mockReturnValueOnce({
      name: "example.com",
      resellerClubOrderId: "RC-999",
    });
    setDefaultNameservers.mockResolvedValueOnce({ status: "success" });

    const res = await POST(
      makeReq({ domainName: "example.com", method: "default" })
    );
    expect(res.status).toBe(200);
    expect(setDefaultNameservers).toHaveBeenCalledWith("RC-999");
    expect(setCustomNameservers).not.toHaveBeenCalled();
  });
});

// ─── Custom method ────────────────────────────────────────────────
describe("Custom method", () => {
  it("calls setCustomNameservers with NS list (lowercased + trimmed by schema)", async () => {
    findOrderByDomainForUser.mockResolvedValueOnce({ _id: "O1" });
    findOrderDomain.mockReturnValueOnce({
      name: "example.com",
      resellerClubOrderId: "RC-1",
    });
    setCustomNameservers.mockResolvedValueOnce({ status: "success" });

    const res = await POST(
      makeReq({
        domainName: "example.com",
        method: "custom",
        nameservers: ["  NS1.CUSTOM.COM  ", "Ns2.Custom.Com"],
      })
    );
    expect(res.status).toBe(200);
    expect(setCustomNameservers).toHaveBeenCalledWith("RC-1", [
      "ns1.custom.com",
      "ns2.custom.com",
    ]);
    expect(setDefaultNameservers).not.toHaveBeenCalled();
  });
});

// ─── RC failure mapping ──────────────────────────────────────────
describe("RC failure mapping", () => {
  it("RC status !== 'success' → 500 + RC message surfaced", async () => {
    findOrderByDomainForUser.mockResolvedValueOnce({ _id: "O1" });
    findOrderDomain.mockReturnValueOnce({
      name: "example.com",
      resellerClubOrderId: "RC-1",
    });
    setDefaultNameservers.mockResolvedValueOnce({
      status: "error",
      message: "invalid host configuration",
    });

    const res = await POST(
      makeReq({ domainName: "example.com", method: "default" })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("invalid host configuration");
  });

  it("RC failure with no message → falls back to 'Failed to update nameservers'", async () => {
    findOrderByDomainForUser.mockResolvedValueOnce({ _id: "O1" });
    findOrderDomain.mockReturnValueOnce({
      name: "example.com",
      resellerClubOrderId: "RC-1",
    });
    setDefaultNameservers.mockResolvedValueOnce({ status: "error" });

    const res = await POST(
      makeReq({ domainName: "example.com", method: "default" })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to update nameservers");
  });
});

// ─── Outer catch ──────────────────────────────────────────────────
describe("Outer catch", () => {
  it("ownership check throw → 500 generic 'Failed to update nameservers'", async () => {
    findOrderByDomainForUser.mockRejectedValueOnce(new Error("DB blew up"));
    const res = await POST(
      makeReq({ domainName: "example.com", method: "default" })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to update nameservers");
  });

  it("RC SDK throw → 500 generic (no SDK internals leaked)", async () => {
    findOrderByDomainForUser.mockResolvedValueOnce({ _id: "O1" });
    findOrderDomain.mockReturnValueOnce({
      name: "example.com",
      resellerClubOrderId: "RC-1",
    });
    setDefaultNameservers.mockRejectedValueOnce(new Error("RC SDK crashed"));
    const res = await POST(
      makeReq({ domainName: "example.com", method: "default" })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to update nameservers");
  });
});
