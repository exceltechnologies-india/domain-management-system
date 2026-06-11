/**
 * Tests for `app/api/domains/verify-status/route.ts` (slice 7hd,
 * part 2). Customer checks whether their pending domain has been
 * fully registered at ResellerClub yet.
 *
 * Pins:
 *  - Auth → 401
 *  - zod schema: domainName trim+lowercase+3-253
 *  - **IDOR via findOrderByDomainForUser(user._id, domainName)**
 *    — non-owner → 404 'Domain not found'
 *  - findOrderDomain null OR missing resellerClubCustomerId → 404
 *    'Registrar customer reference not found' (defensive — stale
 *    order index or partially-provisioned domain)
 *  - **RC typed-outcome dispatch (3 branches)**:
 *      - 'not_found' → 200 with `status:'pending'` (domain queued
 *        but not yet visible in RC; common during registration
 *        lag)
 *      - 'hard_failure' → 200 with `success:false` and
 *        outcome.reason surfaced
 *      - default success → check `domainstatus === 'Active'`
 *        STRICTLY (no case-insensitivity, no contains-match):
 *        true → status 'registered'; false → status 'pending'
 *        with explanatory message
 *  - Response carries resellerClubData passthrough on success
 *    (front-end displays the raw status)
 *  - Outer catch → 500 'Internal server error' generic
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const findOrderByDomainForUser = vi.hoisted(() => vi.fn());
const findOrderDomain = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  findOrderByDomainForUser,
  findOrderDomain,
}));

const getDomainDetails = vi.hoisted(() => vi.fn());
vi.mock("@/lib/integrations/resellerclub", () => ({
  getDomainDetails,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/domains/verify-status/route";

function makeReq(body: unknown) {
  return new NextRequest("https://example.com/api/domains/verify-status", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const user = { _id: "U1", email: "alice@example.com" };

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(user);
  findOrderByDomainForUser.mockReset();
  findOrderDomain.mockReset();
  getDomainDetails.mockReset();
});

describe("Auth gate", () => {
  it("no user → 401; NO order lookup", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ domainName: "alice.com" }));
    expect(res.status).toBe(401);
    expect(findOrderByDomainForUser).not.toHaveBeenCalled();
  });
});

describe("Body validation + IDOR scope", () => {
  it("missing domainName → 400", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
  });

  it("domainName lowercased before IDOR lookup", async () => {
    findOrderByDomainForUser.mockResolvedValueOnce(null);
    await POST(makeReq({ domainName: "ALICE.COM" }));
    expect(findOrderByDomainForUser).toHaveBeenCalledWith("U1", "alice.com");
  });

  it("non-owner → 404 'Domain not found'; NO RC call", async () => {
    findOrderByDomainForUser.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ domainName: "stranger.com" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Domain not found");
    expect(getDomainDetails).not.toHaveBeenCalled();
  });

  it("order found but findOrderDomain null → 404 'Registrar customer reference not found'", async () => {
    findOrderByDomainForUser.mockResolvedValueOnce({ _id: "O1" });
    findOrderDomain.mockReturnValueOnce(null);
    const res = await POST(makeReq({ domainName: "alice.com" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("Registrar customer reference");
    expect(getDomainDetails).not.toHaveBeenCalled();
  });

  it("missing resellerClubCustomerId → 404 'Registrar customer reference not found' (defensive — partial provision)", async () => {
    findOrderByDomainForUser.mockResolvedValueOnce({ _id: "O1" });
    findOrderDomain.mockReturnValueOnce({
      name: "alice.com",
      resellerClubCustomerId: undefined,
    });
    const res = await POST(makeReq({ domainName: "alice.com" }));
    expect(res.status).toBe(404);
    expect(getDomainDetails).not.toHaveBeenCalled();
  });
});

describe("RC typed-outcome dispatch — 3 branches", () => {
  beforeEach(() => {
    findOrderByDomainForUser.mockResolvedValue({ _id: "O1" });
    findOrderDomain.mockReturnValue({
      name: "alice.com",
      resellerClubCustomerId: "RC-CUST-1",
    });
  });

  it("not_found → 200 with status:'pending' + 'likely pending registration' message", async () => {
    getDomainDetails.mockResolvedValueOnce({ kind: "not_found" });
    const res = await POST(makeReq({ domainName: "alice.com" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      domainName: "alice.com",
      status: "pending",
      message: "Domain not found in ResellerClub - likely pending registration",
      resellerClubStatus: "not_found",
    });
  });

  it("hard_failure → 200 with success:false and outcome.reason surfaced", async () => {
    getDomainDetails.mockResolvedValueOnce({
      kind: "hard_failure",
      reason: "RC API rate-limited",
    });
    const res = await POST(makeReq({ domainName: "alice.com" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: false,
      error: "RC API rate-limited",
    });
  });
});

describe("domainstatus === 'Active' STRICT check", () => {
  beforeEach(() => {
    findOrderByDomainForUser.mockResolvedValue({ _id: "O1" });
    findOrderDomain.mockReturnValue({
      name: "alice.com",
      resellerClubCustomerId: "RC-CUST-1",
    });
  });

  it("domainstatus === 'Active' → status:'registered'", async () => {
    getDomainDetails.mockResolvedValueOnce({
      kind: "ok",
      details: { domainstatus: "Active", endtime: 1234567890 },
    });
    const res = await POST(makeReq({ domainName: "alice.com" }));
    const body = await res.json();
    expect(body.status).toBe("registered");
    expect(body.message).toBe("Domain is registered and active");
    expect(body.resellerClubStatus).toBe("Active");
    expect(body.resellerClubData).toEqual({
      domainstatus: "Active",
      endtime: 1234567890,
    });
  });

  it.each(["Inactive", "Suspended", "Pending", "active", "ACTIVE"])(
    "domainstatus=%p → status:'pending' (STRICT case-sensitive match — 'Active' alone passes)",
    async (status) => {
      getDomainDetails.mockResolvedValueOnce({
        kind: "ok",
        details: { domainstatus: status },
      });
      const body = await (
        await POST(makeReq({ domainName: "alice.com" }))
      ).json();
      expect(body.status).toBe("pending");
      expect(body.message).toBe("Domain found but not yet active");
    }
  );

  it("missing domainstatus → resellerClubStatus 'unknown' fallback", async () => {
    getDomainDetails.mockResolvedValueOnce({
      kind: "ok",
      details: {},
    });
    const body = await (
      await POST(makeReq({ domainName: "alice.com" }))
    ).json();
    expect(body.resellerClubStatus).toBe("unknown");
    expect(body.status).toBe("pending");
  });
});

describe("Outer catch", () => {
  it("findOrderByDomainForUser throw → 500 'Internal server error'", async () => {
    findOrderByDomainForUser.mockRejectedValueOnce(new Error("Mongo timeout"));
    const res = await POST(makeReq({ domainName: "alice.com" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(body.error).not.toContain("Mongo");
  });
});
