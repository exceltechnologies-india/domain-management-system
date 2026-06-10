/**
 * Tests for `app/api/admin/domains/nameservers/route.ts` (slice
 * 7ha, part 2). Admin-scoped variant of the 7ge customer
 * nameserver-change endpoint. Same input contract, same RC call,
 * but admin can reach ANY customer's domain (uses findOrderByDomain,
 * NOT findOrderByDomainForUser).
 *
 * Pins:
 *  - Admin gate via getAdminFromRequest → 403 'Admin access
 *    required' (NOT 401 — pinned distinct from the customer
 *    variant which uses 401 in 7ge)
 *  - zod schema: domainName regex, method enum default|custom,
 *    nameservers array of ≥2 valid hosts when method=custom
 *  - **findOrderByDomain — NOT user-scoped**: admin can reach
 *    any order. The user variant (7ge) uses
 *    findOrderByDomainForUser; pinning this difference catches a
 *    refactor that accidentally locks admins out.
 *  - Order not found → 404 'Domain not found'
 *  - findOrderDomain null on a found order → 404 'Domain not
 *    found in order' (defensive — stale order index)
 *  - Missing resellerClubOrderId → 400 'does not have a
 *    ResellerClub Order ID'
 *  - default method → setDefaultNameservers
 *  - custom method → setCustomNameservers with lowercased+trimmed
 *    list
 *  - RC success → 200 'Nameservers updated successfully'
 *  - RC failure (status !== 'success') → 500 + RC.message
 *    surfaced (admin needs the real reason)
 *  - RC failure with no message → fallback 'Failed to update
 *    nameservers'
 *  - Outer catch → 500 'Failed to update nameservers' generic
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const findOrderByDomain = vi.hoisted(() => vi.fn());
const findOrderDomain = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  findOrderByDomain,
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

import { POST } from "@/app/api/admin/domains/nameservers/route";

function makeReq(body: unknown) {
  return new NextRequest("https://example.com/api/admin/domains/nameservers", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  getAdminFromRequest.mockReset();
  findOrderByDomain.mockReset();
  findOrderDomain.mockReset();
  setDefaultNameservers.mockReset();
  setCustomNameservers.mockReset();
});

describe("Admin gate (403, NOT 401 — distinguishes from 7ge customer variant)", () => {
  it("non-admin → 403 'Admin access required'; NO order lookup", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await POST(
      makeReq({ domainName: "example.com", method: "default" })
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Admin access required");
    expect(findOrderByDomain).not.toHaveBeenCalled();
  });
});

describe("Body validation", () => {
  beforeEach(() => {
    getAdminFromRequest.mockResolvedValue({ _id: "A1", email: "admin@example.com" });
  });

  it("invalid domain format → 400", async () => {
    const res = await POST(makeReq({ domainName: "x", method: "default" }));
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

describe("Order lookup — admin scope (NOT user-scoped)", () => {
  beforeEach(() => {
    getAdminFromRequest.mockResolvedValue({ _id: "A1" });
  });

  it("findOrderByDomain called with the domain — NOT findOrderByDomainForUser (admin reaches any order)", async () => {
    findOrderByDomain.mockResolvedValueOnce(null);
    await POST(makeReq({ domainName: "anyones.com", method: "default" }));
    expect(findOrderByDomain).toHaveBeenCalledWith("anyones.com");
  });

  it("order not found → 404 'Domain not found' (no NOT_FOUND code — different from user route's ambiguous 'Domain not found or unauthorized')", async () => {
    findOrderByDomain.mockResolvedValueOnce(null);
    const res = await POST(
      makeReq({ domainName: "ghost.com", method: "default" })
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Domain not found");
    // Pinned distinct from user variant — admin DOES want the
    // unambiguous signal (so they know to check the customer's
    // account vs a typo)
  });

  it("findOrderDomain null → 404 'Domain not found in order'", async () => {
    findOrderByDomain.mockResolvedValueOnce({ _id: "O1" });
    findOrderDomain.mockReturnValueOnce(null);
    const res = await POST(
      makeReq({ domainName: "example.com", method: "default" })
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Domain not found in order");
  });

  it("missing resellerClubOrderId → 400 'does not have a ResellerClub Order ID'", async () => {
    findOrderByDomain.mockResolvedValueOnce({ _id: "O1" });
    findOrderDomain.mockReturnValueOnce({
      name: "example.com",
      resellerClubOrderId: undefined,
    });
    const res = await POST(
      makeReq({ domainName: "example.com", method: "default" })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("ResellerClub Order ID");
  });
});

describe("Default method", () => {
  beforeEach(() => {
    getAdminFromRequest.mockResolvedValue({ _id: "A1" });
  });

  it("calls setDefaultNameservers with the RC order id; setCustom NOT called", async () => {
    findOrderByDomain.mockResolvedValueOnce({ _id: "O1" });
    findOrderDomain.mockReturnValueOnce({
      name: "example.com",
      resellerClubOrderId: "RC-1",
    });
    setDefaultNameservers.mockResolvedValueOnce({ status: "success" });

    const res = await POST(
      makeReq({ domainName: "example.com", method: "default" })
    );
    expect(res.status).toBe(200);
    expect(setDefaultNameservers).toHaveBeenCalledWith("RC-1");
    expect(setCustomNameservers).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.message).toBe("Nameservers updated successfully");
  });
});

describe("Custom method", () => {
  beforeEach(() => {
    getAdminFromRequest.mockResolvedValue({ _id: "A1" });
  });

  it("calls setCustomNameservers with RC order id + NS list lowercased+trimmed by schema", async () => {
    findOrderByDomain.mockResolvedValueOnce({ _id: "O1" });
    findOrderDomain.mockReturnValueOnce({
      name: "example.com",
      resellerClubOrderId: "RC-CUSTOM",
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
    expect(setCustomNameservers).toHaveBeenCalledWith("RC-CUSTOM", [
      "ns1.custom.com",
      "ns2.custom.com",
    ]);
  });
});

describe("RC failure mapping", () => {
  beforeEach(() => {
    getAdminFromRequest.mockResolvedValue({ _id: "A1" });
    findOrderByDomain.mockResolvedValue({ _id: "O1" });
    findOrderDomain.mockReturnValue({
      name: "example.com",
      resellerClubOrderId: "RC-1",
    });
  });

  it("status !== 'success' + message → 500 with RC.message surfaced (admin debugging)", async () => {
    setDefaultNameservers.mockResolvedValueOnce({
      status: "error",
      message: "RC error: invalid registrar config",
    });
    const res = await POST(
      makeReq({ domainName: "example.com", method: "default" })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("RC error: invalid registrar config");
  });

  it("status !== 'success' + no message → fallback 'Failed to update nameservers'", async () => {
    setDefaultNameservers.mockResolvedValueOnce({ status: "error" });
    const res = await POST(
      makeReq({ domainName: "example.com", method: "default" })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to update nameservers");
  });
});

describe("Outer catch", () => {
  beforeEach(() => {
    getAdminFromRequest.mockResolvedValue({ _id: "A1" });
  });

  it("findOrderByDomain throw → 500 'Failed to update nameservers' generic", async () => {
    findOrderByDomain.mockRejectedValueOnce(new Error("Mongo timeout"));
    const res = await POST(
      makeReq({ domainName: "example.com", method: "default" })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to update nameservers");
    expect(body.error).not.toContain("Mongo");
  });
});
