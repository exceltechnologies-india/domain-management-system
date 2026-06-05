/**
 * Tests for `app/api/admin/pending-domains/route.ts` (rescan-4 slice
 * 7g9). Admin pending-domains LIST (GET) + CREATE (POST). The LIST
 * merges two sources: the PendingDomain collection (long-lived rows
 * after registration failures) AND in-flight Orders with pending/
 * processing domain entries (live transactional state). Pins:
 *
 * GET:
 *  - Admin auth gate (NOT user auth) → 401 'Unauthorized'
 *  - Query params: status filter ('all' means no filter); page (1-based);
 *    limit (default 20); search (regex i-flag against domainName +
 *    orderId); archived flag
 *  - **archived=true** → ONLY archived rows (isArchived:true) AND
 *    skips Order-source merge entirely (archived domains are only in
 *    PendingDomain collection)
 *  - **archived=false (default)** → isArchived:{$ne:true} so legacy
 *    rows with no isArchived field still surface
 *  - PendingDomain.find populated with user fields (firstName,
 *    lastName, email, phone, companyName); sort createdAt:-1; hard
 *    cap 1000 (anti-OOM since in-memory merge loads everything)
 *  - Order-source merge: only domains with status in
 *    ('pending'|'processing'); 'hosting' itemType SKIPPED (don't list
 *    hosting items here); domains already in PendingDomain collection
 *    SKIPPED (anti-duplicate via case-insensitive name match)
 *  - Order-source filter mirroring: status AND search filters
 *    re-applied to the order-derived rows
 *  - Order-source row shape: `_id='order_<orderId>_<domainName>'`
 *    synthetic ID; source:'order'; reason falls back to 'Domain
 *    registration in progress'
 *  - Merged + sorted by createdAt DESC across both sources
 *  - Pagination: skip = (page-1)*limit; pages = Math.ceil(total/limit)
 *  - **statusSummary** counts ONLY rows with a known status
 *    (pending/processing/completed/failed); statusSummary.total counts
 *    only those — unknown statuses don't bump it
 *  - Generic 500 'Unable to fetch... please try again later'
 *    (NEVER exposes internal error details to client — anti-info-leak)
 *
 * POST:
 *  - Admin auth gate → 401
 *  - Schema: domainName trim+lowercase min 3 max 253; price
 *    non-negative; userId ObjectId; orderId min 1; customerId/contactId
 *    union(number|string); reason max 2000
 *  - Duplicate guard: getPendingDomainByName non-null → 400 'already
 *    exists'
 *  - Defaults: currency 'INR'; registrationPeriod 1; reason 'Domain
 *    registration failed - likely due to insufficient funds';
 *    status 'pending'; verificationAttempts 0
 *  - Generic 500 'Unable to create... please try again later'
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const connectDB = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

const pendingDomainFind = vi.hoisted(() => vi.fn());
const PendingDomainCtor = vi.hoisted(() =>
  vi.fn(function (this: any, payload: any) {
    Object.assign(this, payload);
    this.save = vi.fn().mockResolvedValue(undefined);
  })
);
vi.mock("@/models/PendingDomain", () => ({
  default: Object.assign(PendingDomainCtor, { find: pendingDomainFind }),
}));

const getPendingDomainByName = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/pending-domains", () => ({ getPendingDomainByName }));

const listOrdersWithInFlightDomains = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({ listOrdersWithInFlightDomains }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET, POST } from "@/app/api/admin/pending-domains/route";

function makeGetReq(qs = "") {
  const url = qs
    ? `https://example.com/api/admin/pending-domains?${qs}`
    : "https://example.com/api/admin/pending-domains";
  return new NextRequest(url, { method: "GET" });
}

function makePostReq(body: unknown) {
  return new NextRequest("https://example.com/api/admin/pending-domains", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Chainable query stub for PendingDomain.find(...).populate().sort().limit().lean()
function chainPDQuery(resolved: unknown[]) {
  const q: any = {
    populate: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(resolved),
  };
  return q;
}

function makePendingDomain(overrides: Partial<any> = {}) {
  return {
    _id: { toString: () => "PD1" },
    domainName: "alice.com",
    status: "pending",
    isArchived: false,
    orderId: "ORD-1",
    userId: {
      _id: "U1",
      firstName: "Alice",
      lastName: "User",
      email: "a@x.com",
    },
    createdAt: new Date("2026-01-15"),
    updatedAt: new Date("2026-01-15"),
    ...overrides,
  };
}

const admin = { _id: "A1", email: "admin@x.com", role: "admin" };

beforeEach(() => {
  getAdminFromRequest.mockReset().mockResolvedValue(admin);
  connectDB.mockReset().mockResolvedValue(undefined);
  pendingDomainFind.mockReset();
  PendingDomainCtor.mockClear();
  getPendingDomainByName.mockReset();
  listOrdersWithInFlightDomains.mockReset().mockResolvedValue([]);
});

// ─── GET — admin gate ──────────────────────────────────────────────
describe("GET — admin auth gate", () => {
  it("no admin → 401 'Unauthorized'; NO DB query", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeGetReq());
    expect(res.status).toBe(401);
    expect(pendingDomainFind).not.toHaveBeenCalled();
    expect(listOrdersWithInFlightDomains).not.toHaveBeenCalled();
  });
});

// ─── GET — archived flag ───────────────────────────────────────────
describe("GET — archived flag", () => {
  it("default (no flag): filter isArchived:{$ne:true}; Order-source IS merged in", async () => {
    pendingDomainFind.mockReturnValueOnce(chainPDQuery([]));
    await GET(makeGetReq());
    const filter = pendingDomainFind.mock.calls[0][0];
    expect(filter.isArchived).toEqual({ $ne: true });
    expect(listOrdersWithInFlightDomains).toHaveBeenCalled();
  });

  it("archived=true: filter isArchived:true; Order-source merge SKIPPED entirely", async () => {
    pendingDomainFind.mockReturnValueOnce(chainPDQuery([]));
    await GET(makeGetReq("archived=true"));
    const filter = pendingDomainFind.mock.calls[0][0];
    expect(filter.isArchived).toBe(true);
    expect(listOrdersWithInFlightDomains).not.toHaveBeenCalled();
  });
});

// ─── GET — populate + cap + sort ───────────────────────────────────
describe("GET — populate + hard-cap + sort", () => {
  it("populates user with 5 fields (firstName, lastName, email, phone, companyName)", async () => {
    const q = chainPDQuery([]);
    pendingDomainFind.mockReturnValueOnce(q);
    await GET(makeGetReq());
    expect(q.populate).toHaveBeenCalledWith(
      "userId",
      "firstName lastName email phone companyName"
    );
  });

  it("**hard cap 1000 rows** (anti-OOM since in-memory merge)", async () => {
    const q = chainPDQuery([]);
    pendingDomainFind.mockReturnValueOnce(q);
    await GET(makeGetReq());
    expect(q.limit).toHaveBeenCalledWith(1000);
  });

  it("sort createdAt:-1 (newest-first)", async () => {
    const q = chainPDQuery([]);
    pendingDomainFind.mockReturnValueOnce(q);
    await GET(makeGetReq());
    expect(q.sort).toHaveBeenCalledWith({ createdAt: -1 });
  });
});

// ─── GET — status filter ───────────────────────────────────────────
describe("GET — status filter", () => {
  it("status='all' or absent → NO status filter applied", async () => {
    pendingDomainFind.mockReturnValueOnce(chainPDQuery([]));
    await GET(makeGetReq("status=all"));
    const filter = pendingDomainFind.mock.calls[0][0];
    expect(filter.status).toBeUndefined();
  });

  it("status='pending' → applied to query", async () => {
    pendingDomainFind.mockReturnValueOnce(chainPDQuery([]));
    await GET(makeGetReq("status=pending"));
    const filter = pendingDomainFind.mock.calls[0][0];
    expect(filter.status).toBe("pending");
  });
});

// ─── GET — search filter (case-insensitive regex) ──────────────────
describe("GET — search filter (regex i-flag)", () => {
  it("search → $or over domainName + orderId with case-insensitive regex", async () => {
    pendingDomainFind.mockReturnValueOnce(chainPDQuery([]));
    await GET(makeGetReq("search=Alice"));
    const filter = pendingDomainFind.mock.calls[0][0];
    expect(filter.$or).toEqual([
      { domainName: { $regex: "Alice", $options: "i" } },
      { orderId: { $regex: "Alice", $options: "i" } },
    ]);
  });
});

// ─── GET — pagination ──────────────────────────────────────────────
describe("GET — pagination", () => {
  it("defaults: page=1, limit=20", async () => {
    pendingDomainFind.mockReturnValueOnce(
      chainPDQuery(
        Array.from({ length: 50 }, (_, i) =>
          makePendingDomain({ _id: { toString: () => `PD${i}` } })
        )
      )
    );
    const res = await GET(makeGetReq());
    const body = await res.json();
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.limit).toBe(20);
    expect(body.pendingDomains).toHaveLength(20);
  });

  it("page=2 limit=10 → returns rows 10-19", async () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      makePendingDomain({
        _id: { toString: () => `PD${i}` },
        domainName: `d${i}.com`,
        createdAt: new Date(`2026-01-${String(25 - i).padStart(2, "0")}`),
      })
    );
    pendingDomainFind.mockReturnValueOnce(chainPDQuery(rows));
    const res = await GET(makeGetReq("page=2&limit=10"));
    const body = await res.json();
    expect(body.pagination.page).toBe(2);
    expect(body.pagination.pages).toBe(3); // ceil(25/10)
    expect(body.pagination.total).toBe(25);
    expect(body.pendingDomains).toHaveLength(10);
  });
});

// ─── GET — Order-source merge ──────────────────────────────────────
describe("GET — Order-source merge", () => {
  it("Order domain (pending status) → merged as source:'order' with synthetic _id", async () => {
    pendingDomainFind.mockReturnValueOnce(chainPDQuery([]));
    listOrdersWithInFlightDomains.mockResolvedValueOnce([
      {
        _id: "ORD_OID_1",
        orderId: "ORD-NEW",
        userId: "U2",
        createdAt: new Date("2026-02-01"),
        updatedAt: new Date("2026-02-01"),
        domains: [
          {
            domainName: "live.com",
            status: "pending",
            price: 999,
            currency: "INR",
            registrationPeriod: 1,
            error: "",
          },
        ],
      },
    ]);

    const res = await GET(makeGetReq());
    const body = await res.json();
    expect(body.pendingDomains).toHaveLength(1);
    expect(body.pendingDomains[0].source).toBe("order");
    expect(body.pendingDomains[0]._id).toBe(
      "order_ORD_OID_1_live.com"
    );
    expect(body.pendingDomains[0].reason).toBe(
      "Domain registration in progress" // fallback when error empty
    );
  });

  it("Order domain with itemType='hosting' SKIPPED (don't list hosting here)", async () => {
    pendingDomainFind.mockReturnValueOnce(chainPDQuery([]));
    listOrdersWithInFlightDomains.mockResolvedValueOnce([
      {
        _id: "ORD-1",
        orderId: "ORD-1",
        userId: "U2",
        createdAt: new Date(),
        updatedAt: new Date(),
        domains: [
          {
            domainName: "host.example.com",
            status: "pending",
            itemType: "hosting",
            price: 1500,
            currency: "INR",
            registrationPeriod: 1,
          },
        ],
      },
    ]);

    const res = await GET(makeGetReq());
    const body = await res.json();
    expect(body.pendingDomains).toHaveLength(0);
  });

  it("Order domain already in PendingDomain collection → SKIPPED (case-insensitive name dedup)", async () => {
    pendingDomainFind.mockReturnValueOnce(
      chainPDQuery([makePendingDomain({ domainName: "alice.com" })])
    );
    listOrdersWithInFlightDomains.mockResolvedValueOnce([
      {
        _id: "ORD-2",
        orderId: "ORD-2",
        userId: "U2",
        createdAt: new Date(),
        updatedAt: new Date(),
        domains: [
          {
            domainName: "ALICE.COM", // different case
            status: "pending",
            price: 999,
            currency: "INR",
            registrationPeriod: 1,
          },
        ],
      },
    ]);

    const res = await GET(makeGetReq());
    const body = await res.json();
    // Only the PendingDomain-collection row, not the duplicate from Orders
    expect(body.pendingDomains).toHaveLength(1);
    expect(body.pendingDomains[0].source).toBe("pending_domain");
  });

  it("Order domain status NOT pending/processing → SKIPPED", async () => {
    pendingDomainFind.mockReturnValueOnce(chainPDQuery([]));
    listOrdersWithInFlightDomains.mockResolvedValueOnce([
      {
        _id: "ORD-3",
        orderId: "ORD-3",
        userId: "U2",
        createdAt: new Date(),
        updatedAt: new Date(),
        domains: [
          {
            domainName: "registered.com",
            status: "registered", // not pending/processing
            price: 999,
            currency: "INR",
            registrationPeriod: 1,
          },
        ],
      },
    ]);

    const res = await GET(makeGetReq());
    const body = await res.json();
    expect(body.pendingDomains).toHaveLength(0);
  });

  it("Order-source status filter re-applied (anti-stale-merge)", async () => {
    pendingDomainFind.mockReturnValueOnce(chainPDQuery([]));
    listOrdersWithInFlightDomains.mockResolvedValueOnce([
      {
        _id: "ORD-4",
        orderId: "ORD-4",
        userId: "U2",
        createdAt: new Date(),
        updatedAt: new Date(),
        domains: [
          {
            domainName: "p.com",
            status: "pending",
            price: 999,
            currency: "INR",
            registrationPeriod: 1,
          },
          {
            domainName: "pr.com",
            status: "processing",
            price: 999,
            currency: "INR",
            registrationPeriod: 1,
          },
        ],
      },
    ]);

    const res = await GET(makeGetReq("status=processing"));
    const body = await res.json();
    expect(body.pendingDomains).toHaveLength(1);
    expect(body.pendingDomains[0].domainName).toBe("pr.com");
  });

  it("Order-source search filter re-applied (matches domainName OR orderId)", async () => {
    pendingDomainFind.mockReturnValueOnce(chainPDQuery([]));
    // 'TARGET' chosen carefully — appears ONLY in orderId of row 1, not in any
    // domain names, so the includes(...) substring match doesn't false-positive
    listOrdersWithInFlightDomains.mockResolvedValueOnce([
      {
        _id: "ORD-5",
        orderId: "ORD-TARGET",
        userId: "U2",
        createdAt: new Date(),
        updatedAt: new Date(),
        domains: [
          {
            domainName: "alice.com",
            status: "pending",
            price: 999,
            currency: "INR",
            registrationPeriod: 1,
          },
        ],
      },
      {
        _id: "ORD-6",
        orderId: "ORD-OTHER",
        userId: "U2",
        createdAt: new Date(),
        updatedAt: new Date(),
        domains: [
          {
            domainName: "bob.com",
            status: "pending",
            price: 999,
            currency: "INR",
            registrationPeriod: 1,
          },
        ],
      },
    ]);

    const res = await GET(makeGetReq("search=TARGET"));
    const body = await res.json();
    expect(body.pendingDomains).toHaveLength(1);
    expect(body.pendingDomains[0].orderId).toBe("ORD-TARGET");
  });
});

// ─── GET — merge + sort ────────────────────────────────────────────
describe("GET — merge + global createdAt:-1 sort", () => {
  it("merged rows sorted by createdAt DESC across BOTH sources", async () => {
    pendingDomainFind.mockReturnValueOnce(
      chainPDQuery([
        makePendingDomain({
          domainName: "old.com",
          createdAt: new Date("2026-01-01"),
        }),
        makePendingDomain({
          domainName: "newer.com",
          createdAt: new Date("2026-02-15"),
        }),
      ])
    );
    listOrdersWithInFlightDomains.mockResolvedValueOnce([
      {
        _id: "ORD-X",
        orderId: "ORD-X",
        userId: "U2",
        createdAt: new Date("2026-02-10"),
        updatedAt: new Date(),
        domains: [
          {
            domainName: "middle.com",
            status: "pending",
            price: 999,
            currency: "INR",
            registrationPeriod: 1,
          },
        ],
      },
    ]);

    const res = await GET(makeGetReq());
    const body = await res.json();
    expect(body.pendingDomains.map((d: any) => d.domainName)).toEqual([
      "newer.com",
      "middle.com",
      "old.com",
    ]);
  });
});

// ─── GET — statusSummary ──────────────────────────────────────────
describe("GET — statusSummary", () => {
  it("counts known statuses only (pending/processing/completed/failed)", async () => {
    pendingDomainFind.mockReturnValueOnce(
      chainPDQuery([
        makePendingDomain({ status: "pending" }),
        makePendingDomain({ status: "pending" }),
        makePendingDomain({ status: "processing" }),
        makePendingDomain({ status: "completed" }),
        makePendingDomain({ status: "failed" }),
        makePendingDomain({ status: "weird_status" }), // not counted
      ])
    );

    const res = await GET(makeGetReq());
    const body = await res.json();
    expect(body.statusSummary).toEqual({
      total: 5, // weird_status NOT included in total
      pending: 2,
      processing: 1,
      completed: 1,
      failed: 1,
    });
  });
});

// ─── GET — error handling ──────────────────────────────────────────
describe("GET — generic 500 (anti-info-leak)", () => {
  it("DB throw → 500 with GENERIC message (NO internal error details)", async () => {
    pendingDomainFind.mockImplementationOnce(() => {
      throw new Error("Internal Mongoose error: secret stack trace");
    });

    const res = await GET(makeGetReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe(
      "Unable to fetch pending domains. Please try again later."
    );
    expect(body.error).not.toMatch(/Mongoose/);
    expect(body.error).not.toMatch(/secret/);
  });
});

// ─── POST — admin gate ────────────────────────────────────────────
describe("POST — admin auth gate", () => {
  it("no admin → 401; NO schema validation, NO DB write", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await POST(
      makePostReq({
        domainName: "x.com",
        price: 0,
        userId: "U1",
        orderId: "ORD-1",
        customerId: 1,
        contactId: 1,
      })
    );
    expect(res.status).toBe(401);
    expect(getPendingDomainByName).not.toHaveBeenCalled();
    expect(PendingDomainCtor).not.toHaveBeenCalled();
  });
});

// ─── POST — schema ────────────────────────────────────────────────
describe("POST — schema validation", () => {
  it("domainName < 3 chars → schema rejection", async () => {
    const res = await POST(
      makePostReq({
        domainName: "ab",
        price: 0,
        userId: "507f1f77bcf86cd799439011",
        orderId: "ORD-1",
        customerId: 1,
        contactId: 1,
      })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("invalid userId (not ObjectId) → schema rejection", async () => {
    const res = await POST(
      makePostReq({
        domainName: "alice.com",
        price: 0,
        userId: "not-an-id",
        orderId: "ORD-1",
        customerId: 1,
        contactId: 1,
      })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("negative price → schema rejection", async () => {
    const res = await POST(
      makePostReq({
        domainName: "alice.com",
        price: -1,
        userId: "507f1f77bcf86cd799439011",
        orderId: "ORD-1",
        customerId: 1,
        contactId: 1,
      })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("customerId can be number OR string (RC sometimes returns string)", async () => {
    getPendingDomainByName.mockResolvedValueOnce(null);
    const res = await POST(
      makePostReq({
        domainName: "alice.com",
        price: 0,
        userId: "507f1f77bcf86cd799439011",
        orderId: "ORD-1",
        customerId: "12345", // string
        contactId: 67890, // number
      })
    );
    expect(res.status).toBe(200);
  });

  it("reason > 2000 chars → schema rejection", async () => {
    const res = await POST(
      makePostReq({
        domainName: "alice.com",
        price: 0,
        userId: "507f1f77bcf86cd799439011",
        orderId: "ORD-1",
        customerId: 1,
        contactId: 1,
        reason: "x".repeat(2001),
      })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

// ─── POST — duplicate guard ───────────────────────────────────────
describe("POST — duplicate-domain guard", () => {
  it("getPendingDomainByName non-null → 400 'already exists'", async () => {
    getPendingDomainByName.mockResolvedValueOnce({
      _id: "EXIST",
      domainName: "alice.com",
    });
    const res = await POST(
      makePostReq({
        domainName: "alice.com",
        price: 0,
        userId: "507f1f77bcf86cd799439011",
        orderId: "ORD-1",
        customerId: 1,
        contactId: 1,
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/already exists/);
    expect(PendingDomainCtor).not.toHaveBeenCalled();
  });

  it("**lookup uses lowercased domain** (post-schema-transform) so 'ALICE.COM' hits same lookup as 'alice.com'", async () => {
    getPendingDomainByName.mockResolvedValueOnce({
      _id: "EXIST",
    });
    await POST(
      makePostReq({
        domainName: "  ALICE.COM  ", // schema trims + lowercases
        price: 0,
        userId: "507f1f77bcf86cd799439011",
        orderId: "ORD-1",
        customerId: 1,
        contactId: 1,
      })
    );
    expect(getPendingDomainByName).toHaveBeenCalledWith("alice.com");
  });
});

// ─── POST — defaults + happy path ─────────────────────────────────
describe("POST — defaults + happy path", () => {
  it("defaults: currency='INR', registrationPeriod=1, status='pending', verificationAttempts=0, reason='likely due to insufficient funds'", async () => {
    getPendingDomainByName.mockResolvedValueOnce(null);
    await POST(
      makePostReq({
        domainName: "alice.com",
        price: 999,
        userId: "507f1f77bcf86cd799439011",
        orderId: "ORD-1",
        customerId: 1,
        contactId: 1,
      })
    );

    expect(PendingDomainCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        currency: "INR",
        registrationPeriod: 1,
        status: "pending",
        verificationAttempts: 0,
        reason:
          "Domain registration failed - likely due to insufficient funds",
      })
    );
  });

  it("user-supplied currency / reason override defaults", async () => {
    getPendingDomainByName.mockResolvedValueOnce(null);
    await POST(
      makePostReq({
        domainName: "alice.com",
        price: 999,
        userId: "507f1f77bcf86cd799439011",
        orderId: "ORD-1",
        customerId: 1,
        contactId: 1,
        currency: "USD",
        registrationPeriod: 5,
        reason: "Custom failure reason",
      })
    );
    expect(PendingDomainCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        currency: "USD",
        registrationPeriod: 5,
        reason: "Custom failure reason",
      })
    );
  });

  it("happy response: success + message + pendingDomain", async () => {
    getPendingDomainByName.mockResolvedValueOnce(null);
    const res = await POST(
      makePostReq({
        domainName: "alice.com",
        price: 999,
        userId: "507f1f77bcf86cd799439011",
        orderId: "ORD-1",
        customerId: 1,
        contactId: 1,
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toBe("Pending domain created successfully");
    expect(body.pendingDomain).toBeDefined();
  });
});

// ─── POST — error handling ────────────────────────────────────────
describe("POST — generic 500 (anti-info-leak)", () => {
  it("DB throw → 500 with GENERIC message (NO internal error details)", async () => {
    getPendingDomainByName.mockRejectedValueOnce(
      new Error("Internal Mongoose: secret stack trace")
    );
    const res = await POST(
      makePostReq({
        domainName: "alice.com",
        price: 0,
        userId: "507f1f77bcf86cd799439011",
        orderId: "ORD-1",
        customerId: 1,
        contactId: 1,
      })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe(
      "Unable to create pending domain. Please try again later."
    );
    expect(body.error).not.toMatch(/Mongoose|secret/);
  });
});
