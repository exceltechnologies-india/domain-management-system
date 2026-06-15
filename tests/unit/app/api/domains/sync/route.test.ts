/**
 * Tests for `app/api/domains/sync/route.ts` (slice 7iA, part 1).
 *
 * Customer-facing "import all of my registrar domains" POST. Pulls
 * the customer's entire ResellerClub domain list and back-fills any
 * domains that aren't already on a local order. Handles the case
 * where the customer has no linked RC customerId yet.
 *
 * Threat model:
 *  - **Cross-tenant import**: every per-domain check uses
 *    findOrderByDomainForUser(user._id, name) — a hostile actor
 *    can't synthesize an RC payload that imports under another
 *    customer's userId. Pinned per-loop-iteration.
 *  - **DoS via runaway loop**: per-domain failures are isolated in
 *    a try/catch so one bad RC payload can't kill the rest of the
 *    batch — the response carries imported / skipped / failed
 *    counts so the customer sees partial-success state.
 *  - **Auto-backfill of resellerClubCustomerId**: if the user
 *    record doesn't have a RC customer ID, the route tries to
 *    look it up by email and persists it via `dbUser.save()`
 *    BEFORE proceeding. If the lookup fails, the route returns
 *    200 with `code: NO_LINKED_ACCOUNT` (NOT 404 — pinned, anti-
 *    "console-error-spam" for brand-new customers).
 *
 * Other pins:
 *  - Auth → 401 'Unauthorized'
 *  - getUserById missing → 404 'User not found'
 *  - Metadata keys 'recsonpage' / 'recsindb' SKIPPED (anti-confusion
 *    — RC echoes those at the top level of the response map)
 *  - Domain name resolution order: domain['entity.description'] →
 *    domain.domainname → domain.domain → skip
 *  - Order ID resolution: domain['orders.orderid'] → fallback to
 *    the map key
 *  - RC currentstatus 'active' (case-insensitive, trimmed) →
 *    domainStatus 'registered'; anything else → 'pending'
 *  - registeredAt / expiresAt parsed from Unix seconds (× 1000)
 *  - createOrder shape: orderId pattern `SYNC-${ts}-…`,
 *    paymentMethod NOT set, status 'completed', amount 0,
 *    bookingStatus[0] step varies by domainStatus (registered →
 *    'domain_registered' progress 100; pending → 'payment_verified'
 *    progress 30), resellerClubCustomerId stamped on the domain
 *  - successfulDomains array contains the name ONLY when status
 *    is registered (pending → empty array; pinned per-branch so
 *    pending domains don't accidentally appear in registered
 *    listings downstream)
 *  - Skip-existing path: domain on a prior local order → counted
 *    in `skipped`, NO createOrder call
 *  - Empty registrar response → 200 with imported:0 skipped:0
 *    failed:0 (no error)
 *  - RC getCustomerDomains failure → 500 (not 200) with the
 *    upstream message surfaced; sync ABORTS (no partial creates)
 *  - Outer catch → 500 'Failed to sync domains'
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const getUserById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserById }));

const createOrder = vi.hoisted(() => vi.fn());
const findOrderByDomainForUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({
  createOrder,
  findOrderByDomainForUser,
}));

const getCustomerId = vi.hoisted(() => vi.fn());
const getCustomerDomains = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub", () => ({
  ResellerClubAPI: { getCustomerId, getCustomerDomains },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/domains/sync/route";

function makeReq() {
  return new NextRequest("https://example.com/api/domains/sync", {
    method: "POST",
  });
}

interface FakeDbUser {
  _id: string;
  email: string;
  resellerClubCustomerId?: number;
  save: ReturnType<typeof vi.fn>;
}

function makeDbUser(over: Partial<FakeDbUser> = {}): FakeDbUser {
  return {
    _id: "U1",
    email: "alice@example.com",
    resellerClubCustomerId: 100,
    save: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

const user = { _id: "U1", email: "alice@example.com" };

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(user);
  getUserById.mockReset();
  createOrder.mockReset();
  findOrderByDomainForUser.mockReset();
  getCustomerId.mockReset();
  getCustomerDomains.mockReset();
});

// ═══════════════════════════════════════════════════════════════════
// Auth + user-record gates
// ═══════════════════════════════════════════════════════════════════
describe("Auth + user-record gates", () => {
  it("no auth user → 401 'Unauthorized'; NO downstream RC call", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makeReq());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
    expect(getUserById).not.toHaveBeenCalled();
    expect(getCustomerDomains).not.toHaveBeenCalled();
  });

  it("getUserById null → 404 'User not found'; NO RC call", async () => {
    getUserById.mockResolvedValueOnce(null);
    const res = await POST(makeReq());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("User not found");
    expect(getCustomerDomains).not.toHaveBeenCalled();
  });

  it("getUserById receives String(user._id) — coerces ObjectId-shaped _id", async () => {
    const objId = { toString: () => "507f1f77bcf86cd799439011" };
    getUserFromRequest.mockResolvedValueOnce({ ...user, _id: objId });
    getUserById.mockResolvedValueOnce(makeDbUser());
    getCustomerDomains.mockResolvedValueOnce({ status: "success", data: {} });
    await POST(makeReq());
    expect(getUserById).toHaveBeenCalledWith("507f1f77bcf86cd799439011");
  });
});

// ═══════════════════════════════════════════════════════════════════
// resellerClubCustomerId backfill flow
// ═══════════════════════════════════════════════════════════════════
describe("resellerClubCustomerId backfill", () => {
  it("missing customerId + RC lookup success → persist via dbUser.save(), then proceed", async () => {
    const dbUser = makeDbUser({ resellerClubCustomerId: undefined });
    getUserById.mockResolvedValueOnce(dbUser);
    getCustomerId.mockResolvedValueOnce({ status: "success", customerId: 999 });
    getCustomerDomains.mockResolvedValueOnce({ status: "success", data: {} });

    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    expect(getCustomerId).toHaveBeenCalledWith("alice@example.com");
    expect(dbUser.save).toHaveBeenCalled();
    expect(dbUser.resellerClubCustomerId).toBe(999);
    expect(getCustomerDomains).toHaveBeenCalledWith(999);
  });

  it("missing customerId + RC lookup fail → 200 NO_LINKED_ACCOUNT (NOT 404 — anti-console-spam for new users)", async () => {
    getUserById.mockResolvedValueOnce(makeDbUser({ resellerClubCustomerId: undefined }));
    getCustomerId.mockResolvedValueOnce({ status: "error", message: "not in RC" });
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe("NO_LINKED_ACCOUNT");
    expect(getCustomerDomains).not.toHaveBeenCalled();
  });

  it("missing customerId + lookup success but customerId field absent → 200 NO_LINKED_ACCOUNT (defensive)", async () => {
    getUserById.mockResolvedValueOnce(makeDbUser({ resellerClubCustomerId: undefined }));
    getCustomerId.mockResolvedValueOnce({ status: "success" });
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code).toBe("NO_LINKED_ACCOUNT");
  });

  it("present customerId → skips lookup entirely (no RC.getCustomerId call)", async () => {
    getUserById.mockResolvedValueOnce(makeDbUser({ resellerClubCustomerId: 42 }));
    getCustomerDomains.mockResolvedValueOnce({ status: "success", data: {} });
    await POST(makeReq());
    expect(getCustomerId).not.toHaveBeenCalled();
    expect(getCustomerDomains).toHaveBeenCalledWith(42);
  });
});

// ═══════════════════════════════════════════════════════════════════
// RC getCustomerDomains response handling
// ═══════════════════════════════════════════════════════════════════
describe("RC getCustomerDomains failure", () => {
  it("RC error status → 500 with upstream message; NO createOrder calls", async () => {
    getUserById.mockResolvedValueOnce(makeDbUser());
    getCustomerDomains.mockResolvedValueOnce({
      status: "error",
      message: "RC connection refused",
    });
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch domains from our registrar");
    expect(body.message).toBe("RC connection refused");
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("RC success with missing data → 500 (defensive)", async () => {
    getUserById.mockResolvedValueOnce(makeDbUser());
    getCustomerDomains.mockResolvedValueOnce({ status: "success" });
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    expect(createOrder).not.toHaveBeenCalled();
  });
});

describe("Empty registrar response", () => {
  it("empty domain map → 200 with imported:0 skipped:0 failed:0; NO createOrder", async () => {
    getUserById.mockResolvedValueOnce(makeDbUser());
    getCustomerDomains.mockResolvedValueOnce({ status: "success", data: {} });
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.imported).toBe(0);
    expect(body.skipped).toBe(0);
    expect(body.failed).toBe(0);
    expect(createOrder).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Metadata key skip
// ═══════════════════════════════════════════════════════════════════
describe("Metadata key skip", () => {
  it("'recsonpage' and 'recsindb' keys are NOT treated as domains", async () => {
    getUserById.mockResolvedValueOnce(makeDbUser());
    getCustomerDomains.mockResolvedValueOnce({
      status: "success",
      data: {
        recsonpage: "10",
        recsindb: "50",
      },
    });
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.imported).toBe(0);
    expect(body.skipped).toBe(0);
    expect(createOrder).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Per-domain import
// ═══════════════════════════════════════════════════════════════════
describe("Per-domain import — happy path", () => {
  function setupOne(domain: Record<string, string>) {
    getUserById.mockResolvedValueOnce(makeDbUser());
    getCustomerDomains.mockResolvedValueOnce({
      status: "success",
      data: { "100001": domain },
    });
    findOrderByDomainForUser.mockResolvedValueOnce(null);
    createOrder.mockResolvedValueOnce({});
  }

  it("active RC domain → imported, status 'registered', bookingStatus step 'domain_registered' progress 100", async () => {
    setupOne({
      "entity.description": "alice.com",
      "orders.orderid": "RC-7",
      "orders.currentstatus": "Active",
      "orders.endtime": "1800000000",
      "orders.creationtime": "1700000000",
    });
    const res = await POST(makeReq());
    const body = await res.json();
    expect(body.imported).toBe(1);
    expect(body.failed).toBe(0);
    const createCall = createOrder.mock.calls[0][0];
    expect(createCall.domains[0].domainName).toBe("alice.com");
    expect(createCall.domains[0].status).toBe("registered");
    expect(createCall.domains[0].bookingStatus[0].step).toBe("domain_registered");
    expect(createCall.domains[0].bookingStatus[0].progress).toBe(100);
    expect(createCall.successfulDomains).toEqual(["alice.com"]);
  });

  it("non-active RC status → imported as 'pending'; successfulDomains stays EMPTY (pinned per-branch)", async () => {
    setupOne({
      "entity.description": "pending.com",
      "orders.orderid": "RC-8",
      "orders.currentstatus": "InvoicePaid",
      "orders.endtime": "1800000000",
    });
    const res = await POST(makeReq());
    const body = await res.json();
    expect(body.imported).toBe(1);
    const createCall = createOrder.mock.calls[0][0];
    expect(createCall.domains[0].status).toBe("pending");
    expect(createCall.domains[0].bookingStatus[0].step).toBe("payment_verified");
    expect(createCall.domains[0].bookingStatus[0].progress).toBe(30);
    expect(createCall.successfulDomains).toEqual([]);
  });

  it("RC status 'active' is case-insensitive AND trimmed", async () => {
    setupOne({
      "entity.description": "x.com",
      "orders.orderid": "RC-1",
      "orders.currentstatus": "  ACTIVE  ",
    });
    await POST(makeReq());
    const createCall = createOrder.mock.calls[0][0];
    expect(createCall.domains[0].status).toBe("registered");
  });

  it("missing currentstatus → defaults to pending", async () => {
    setupOne({
      "entity.description": "x.com",
      "orders.orderid": "RC-1",
    });
    await POST(makeReq());
    const createCall = createOrder.mock.calls[0][0];
    expect(createCall.domains[0].status).toBe("pending");
  });

  it("orderId resolution: 'orders.orderid' field wins over the map key", async () => {
    setupOne({
      "entity.description": "x.com",
      "orders.orderid": "RC-PRIORITY-7",
      "orders.currentstatus": "Active",
    });
    await POST(makeReq());
    const createCall = createOrder.mock.calls[0][0];
    expect(createCall.domains[0].resellerClubOrderId).toBe("RC-PRIORITY-7");
  });

  it("orderId fallback: map key used when 'orders.orderid' absent", async () => {
    getUserById.mockResolvedValueOnce(makeDbUser());
    getCustomerDomains.mockResolvedValueOnce({
      status: "success",
      data: { "MAP-KEY-99": { "entity.description": "x.com", "orders.currentstatus": "Active" } },
    });
    findOrderByDomainForUser.mockResolvedValueOnce(null);
    createOrder.mockResolvedValueOnce({});
    await POST(makeReq());
    const createCall = createOrder.mock.calls[0][0];
    expect(createCall.domains[0].resellerClubOrderId).toBe("MAP-KEY-99");
  });

  it("domain-name resolution chain: entity.description → domainname → domain", async () => {
    getUserById.mockResolvedValueOnce(makeDbUser());
    getCustomerDomains.mockResolvedValueOnce({
      status: "success",
      data: {
        a: { domainname: "fromDomainName.com", "orders.currentstatus": "Active" },
        b: { domain: "fromBareDomain.com", "orders.currentstatus": "Active" },
      },
    });
    findOrderByDomainForUser.mockResolvedValue(null);
    createOrder.mockResolvedValue({});
    await POST(makeReq());
    const names = createOrder.mock.calls.map((c) => c[0].domains[0].domainName);
    expect(names).toContain("fromDomainName.com");
    expect(names).toContain("fromBareDomain.com");
  });

  it("missing name entirely → skipped (no createOrder call); skipped++", async () => {
    getUserById.mockResolvedValueOnce(makeDbUser());
    getCustomerDomains.mockResolvedValueOnce({
      status: "success",
      data: { "100001": { "orders.currentstatus": "Active" } },
    });
    const res = await POST(makeReq());
    const body = await res.json();
    expect(body.imported).toBe(0);
    expect(body.skipped).toBe(1);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("expiresAt is parsed from Unix seconds × 1000", async () => {
    setupOne({
      "entity.description": "x.com",
      "orders.endtime": "1700000000",
      "orders.currentstatus": "Active",
    });
    await POST(makeReq());
    const createCall = createOrder.mock.calls[0][0];
    const expDate = createCall.domains[0].expiresAt as Date;
    expect(expDate).toBeInstanceOf(Date);
    expect(expDate.getTime()).toBe(1700000000 * 1000);
  });

  it("missing expiry timestamp → expiresAt:null", async () => {
    setupOne({
      "entity.description": "x.com",
      "orders.currentstatus": "Active",
    });
    await POST(makeReq());
    const createCall = createOrder.mock.calls[0][0];
    expect(createCall.domains[0].expiresAt).toBeNull();
  });

  it("resellerClubCustomerId is stamped on the domain (stringified)", async () => {
    setupOne({
      "entity.description": "x.com",
      "orders.currentstatus": "Active",
    });
    await POST(makeReq());
    const createCall = createOrder.mock.calls[0][0];
    expect(createCall.domains[0].resellerClubCustomerId).toBe("100");
  });

  it("createOrder is called with userId = session user._id (anti-injection)", async () => {
    setupOne({
      "entity.description": "x.com",
      "orders.currentstatus": "Active",
    });
    await POST(makeReq());
    const createCall = createOrder.mock.calls[0][0];
    expect(createCall.userId).toBe("U1");
  });

  it("createOrder orderId follows the SYNC-${ts}-… pattern", async () => {
    setupOne({
      "entity.description": "x.com",
      "orders.currentstatus": "Active",
    });
    await POST(makeReq());
    const createCall = createOrder.mock.calls[0][0];
    expect(createCall.orderId).toMatch(/^SYNC-\d+-[a-z0-9]+$/i);
    expect(createCall.amount).toBe(0);
    expect(createCall.status).toBe("completed");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Skip-existing & isolation
// ═══════════════════════════════════════════════════════════════════
describe("Skip + isolation behaviour", () => {
  it("existing local order for the domain → skipped++, NO createOrder", async () => {
    getUserById.mockResolvedValueOnce(makeDbUser());
    getCustomerDomains.mockResolvedValueOnce({
      status: "success",
      data: {
        "100001": {
          "entity.description": "alice.com",
          "orders.currentstatus": "Active",
        },
      },
    });
    findOrderByDomainForUser.mockResolvedValueOnce({ orderId: "EXISTING-1" });
    const res = await POST(makeReq());
    const body = await res.json();
    expect(body.imported).toBe(0);
    expect(body.skipped).toBe(1);
    expect(createOrder).not.toHaveBeenCalled();
    const skipped = body.results.find(
      (r: { domain: string; status: string }) => r.domain === "alice.com"
    );
    expect(skipped.status).toBe("skipped");
  });

  it("anti-IDOR: findOrderByDomainForUser is called with (user._id, domainName) — second arg is the session user", async () => {
    getUserById.mockResolvedValueOnce(makeDbUser());
    getCustomerDomains.mockResolvedValueOnce({
      status: "success",
      data: { a: { "entity.description": "alice.com", "orders.currentstatus": "Active" } },
    });
    findOrderByDomainForUser.mockResolvedValueOnce(null);
    createOrder.mockResolvedValueOnce({});
    await POST(makeReq());
    expect(findOrderByDomainForUser).toHaveBeenCalledWith("U1", "alice.com");
  });

  it("per-domain failure isolated — one bad row doesn't kill the rest", async () => {
    getUserById.mockResolvedValueOnce(makeDbUser());
    getCustomerDomains.mockResolvedValueOnce({
      status: "success",
      data: {
        a: { "entity.description": "good.com", "orders.currentstatus": "Active" },
        b: { "entity.description": "bad.com", "orders.currentstatus": "Active" },
        c: { "entity.description": "alsogood.com", "orders.currentstatus": "Active" },
      },
    });
    findOrderByDomainForUser.mockResolvedValue(null);
    createOrder
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("DB write failure"))
      .mockResolvedValueOnce({});
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.imported).toBe(2);
    expect(body.failed).toBe(1);
    expect(createOrder).toHaveBeenCalledTimes(3);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Outer catch
// ═══════════════════════════════════════════════════════════════════
describe("Outer catch", () => {
  it("getUserById throw → 500 'Failed to sync domains' (no leak fragment in error field)", async () => {
    getUserById.mockRejectedValueOnce(
      new Error("Mongo replicaset down: secret-leak-A")
    );
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to sync domains");
  });

  it("RC getCustomerDomains throw → 500 outer catch", async () => {
    getUserById.mockResolvedValueOnce(makeDbUser());
    getCustomerDomains.mockRejectedValueOnce(new Error("RC blew up"));
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
  });
});
