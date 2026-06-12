/**
 * Tests for `app/api/domains/transfer/route.ts` (slice 7hq, part 1).
 *
 * Customer-initiated domain transfer-in flow. Maps the typed RC
 * `transferDomain` outcome to four distinct HTTP responses.
 *
 * Threat model:
 *  - **DB writes on failed transfer**: a refactor that pushes the
 *    Domain row save BEFORE the outcome dispatch (or that misses one
 *    of the 3 failure branches) would create pending Domain rows that
 *    don't actually exist at the registrar. Pinned: NONE of the 3
 *    failure branches (balance_pending / transfer_rejected /
 *    hard_failure) writes to the DB or to appendUserDomain.
 *  - **Customer-actionable vs generic error copy**: transfer_rejected
 *    → 400 with EPP-code / unlocked / 60-day-rule hints; hard_failure
 *    → 500 with generic "team notified" copy. Mixing these would
 *    either expose internal errors or hide actionable fixes from
 *    customers.
 *
 * Other pins:
 *  - Rate-limit BEFORE auth (anti-probe)
 *  - Auth gate → 401
 *  - Zod: domainName trim+lower 3-253; authCode trim 1-128
 *  - getUserById null → 404 (handles deleted-mid-session edge)
 *  - getOrCreateCustomerAndContact error → 500 with RC error string
 *  - Happy path: Domain saved with status:'pending', registrationPeriod:1,
 *    currency:'INR', resellerClubOrderId from RC entityId; appendUserDomain
 *    mirrors that with orderId=entityId
 *  - Outer catch → 500 generic; sentinel NOT leaked
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const isAllowed = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit")>(
    "@/lib/rate-limit"
  );
  return {
    ...actual,
    rateLimiters: { api: { isAllowed } },
  };
});

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const getOrCreateCustomerAndContact = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub", () => ({
  ResellerClubAPI: { getOrCreateCustomerAndContact },
}));

const rcTransferDomain = vi.hoisted(() => vi.fn());
vi.mock("@/lib/integrations/resellerclub", () => ({
  transferDomain: rcTransferDomain,
}));

const getUserById = vi.hoisted(() => vi.fn());
const appendUserDomain = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserById, appendUserDomain }));

vi.mock("@/lib/mongodb", () => ({
  default: vi.fn().mockResolvedValue(undefined),
}));

// Mock Domain model as a constructor that exposes a save() per-instance.
const domainInstanceSave = vi.hoisted(() => vi.fn());
const domainCtorCalls: Array<unknown> = vi.hoisted(() => []);
vi.mock("@/models/Domain", () => {
  class FakeDomain {
    constructor(obj: unknown) {
      domainCtorCalls.push(obj);
      Object.assign(this, obj as object);
    }
    save = domainInstanceSave;
  }
  return { default: FakeDomain };
});

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/domains/transfer/route";

function makeReq(body: unknown) {
  return new NextRequest("https://example.com/api/domains/transfer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const VALID = { domainName: "example.com", authCode: "AUTH-CODE-XYZ" };

const dbUser = {
  email: "alice@example.com",
  firstName: "Alice",
  lastName: "Smith",
  phone: "9999999999",
  companyName: "Acme",
  address: {
    line1: "1 main st",
    city: "Mumbai",
    state: "MH",
    country: "IN",
    zipcode: "400001",
  },
};

beforeEach(() => {
  isAllowed.mockReset().mockResolvedValue({ allowed: true, remaining: 100 });
  getUserFromRequest.mockReset().mockResolvedValue({ _id: "U1" });
  getOrCreateCustomerAndContact.mockReset();
  rcTransferDomain.mockReset();
  getUserById.mockReset().mockResolvedValue(dbUser);
  appendUserDomain.mockReset().mockResolvedValue(undefined);
  domainInstanceSave.mockReset().mockResolvedValue(undefined);
  domainCtorCalls.length = 0;
});

describe("Rate limit BEFORE auth (anti-probe)", () => {
  it("rate-limit denied → 429; auth NOT consulted", async () => {
    isAllowed.mockResolvedValueOnce({ allowed: false, remaining: 0 });
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(429);
    expect(getUserFromRequest).not.toHaveBeenCalled();
    expect(rcTransferDomain).not.toHaveBeenCalled();
  });
});

describe("Auth gate", () => {
  it("no user → 401; downstream untouched", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(401);
    expect(rcTransferDomain).not.toHaveBeenCalled();
  });
});

describe("Zod schema", () => {
  it("missing authCode → 400", async () => {
    const res = await POST(makeReq({ domainName: "example.com" }));
    expect(res.status).toBe(400);
    expect(rcTransferDomain).not.toHaveBeenCalled();
  });

  it("authCode > 128 chars → 400", async () => {
    const res = await POST(
      makeReq({ domainName: "example.com", authCode: "x".repeat(129) })
    );
    expect(res.status).toBe(400);
  });

  it("domain trimmed+lower-cased before downstream", async () => {
    getOrCreateCustomerAndContact.mockResolvedValueOnce({
      status: "success",
      customerId: "C1",
      contactId: "K1",
    });
    rcTransferDomain.mockResolvedValueOnce({
      kind: "transfer_initiated",
      entityId: "ENT-1",
    });
    await POST(makeReq({ domainName: "  EXAMPLE.COM  ", authCode: "x" }));
    expect(rcTransferDomain).toHaveBeenCalledWith(
      expect.objectContaining({ domainName: "example.com" })
    );
  });
});

describe("User lookup", () => {
  it("getUserById null → 404; RC never called", async () => {
    getUserById.mockResolvedValueOnce(null);
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(404);
    expect(rcTransferDomain).not.toHaveBeenCalled();
  });
});

describe("RC customer pre-flight", () => {
  it("getOrCreateCustomerAndContact error → 500; transferDomain NOT called", async () => {
    getOrCreateCustomerAndContact.mockResolvedValueOnce({
      status: "error",
      error: "RC down — rc_sa_key_LEAK_ME_NOT_HERE",
    });
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(500);
    expect(rcTransferDomain).not.toHaveBeenCalled();
  });

  it("missing customerId → 500 (defensive — even with status=success)", async () => {
    getOrCreateCustomerAndContact.mockResolvedValueOnce({
      status: "success",
      // No customerId / contactId
    });
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(500);
  });

  it("missing contactId → 500", async () => {
    getOrCreateCustomerAndContact.mockResolvedValueOnce({
      status: "success",
      customerId: "C1",
      // No contactId
    });
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(500);
  });

  it("contacts.admin / tech / billing all set to the same contactId", async () => {
    getOrCreateCustomerAndContact.mockResolvedValueOnce({
      status: "success",
      customerId: "C1",
      contactId: "K1",
    });
    rcTransferDomain.mockResolvedValueOnce({
      kind: "transfer_initiated",
      entityId: "ENT-1",
    });
    await POST(makeReq(VALID));
    const call = rcTransferDomain.mock.calls[0][0];
    expect(call.contacts).toEqual({
      admin: "K1",
      tech: "K1",
      billing: "K1",
    });
  });
});

describe("RC 4-branch outcome dispatch", () => {
  beforeEach(() => {
    getOrCreateCustomerAndContact.mockResolvedValue({
      status: "success",
      customerId: "C1",
      contactId: "K1",
    });
  });

  it("transfer_initiated → 200; Domain saved with pending+entityId; appendUserDomain mirrors", async () => {
    rcTransferDomain.mockResolvedValueOnce({
      kind: "transfer_initiated",
      entityId: "ENT-789",
    });
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    expect(domainInstanceSave).toHaveBeenCalledTimes(1);
    const ctorArg = domainCtorCalls[0] as Record<string, unknown>;
    expect(ctorArg).toEqual(
      expect.objectContaining({
        domainName: "example.com",
        status: "pending",
        currency: "INR",
        registrationPeriod: 1,
        userId: "U1",
        resellerClubOrderId: "ENT-789",
      })
    );

    expect(appendUserDomain).toHaveBeenCalledWith(
      "U1",
      expect.objectContaining({
        domainName: "example.com",
        status: "pending",
        orderId: "ENT-789",
        currency: "INR",
        registrationPeriod: 1,
      })
    );
  });

  it("balance_pending → 202 'queued'; NO DB write; NO appendUserDomain", async () => {
    rcTransferDomain.mockResolvedValueOnce({ kind: "balance_pending" });
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe("pending");
    expect(body.error.toLowerCase()).toContain("queued");
    expect(domainInstanceSave).not.toHaveBeenCalled();
    expect(appendUserDomain).not.toHaveBeenCalled();
  });

  it("transfer_rejected → 400 with customer-actionable EPP/unlock/60-day hints; NO DB write", async () => {
    rcTransferDomain.mockResolvedValueOnce({ kind: "transfer_rejected" });
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(400);
    const body = await res.json();
    // Customer-actionable hints (NOT internal error noise)
    expect(body.error).toContain("EPP");
    expect(body.error.toLowerCase()).toContain("unlock");
    expect(body.error).toContain("60");
    expect(domainInstanceSave).not.toHaveBeenCalled();
    expect(appendUserDomain).not.toHaveBeenCalled();
  });

  it("hard_failure → 500 with generic 'team notified' copy; NO DB write; sentinel NOT leaked", async () => {
    rcTransferDomain.mockResolvedValueOnce({ kind: "hard_failure" });
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.toLowerCase()).toContain("team");
    expect(domainInstanceSave).not.toHaveBeenCalled();
    expect(appendUserDomain).not.toHaveBeenCalled();
  });
});

describe("Outer catch", () => {
  it("rcTransferDomain throw → 500 generic; sentinel NOT leaked", async () => {
    getOrCreateCustomerAndContact.mockResolvedValueOnce({
      status: "success",
      customerId: "C1",
      contactId: "K1",
    });
    rcTransferDomain.mockRejectedValueOnce(
      new Error("ECONNREFUSED rc-api — rc_sa_key_LEAK_ME")
    );
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to initiate domain transfer");
    expect(JSON.stringify(body)).not.toContain("rc_sa_key_LEAK_ME");
  });
});
