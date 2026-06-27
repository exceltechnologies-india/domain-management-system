/**
 * Tests for `app/api/admin/recurring-charges/route.ts` — the admin
 * dashboard data feed for Tokens-flow MIT charge attempts.
 *
 * Pins:
 *  - 403 when caller is not admin (no DB touched)
 *  - Default window=7d when not specified; respected when valid
 *  - Status filter validated against the enum; invalid values ignored
 *  - Joins each attempt with Hosting (domain) + User (email/name)
 *  - Aggregate counts span the whole window (not the filtered slice)
 *  - hasMore=true when row count equals limit (UI hints "narrow filters")
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const isAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { isAdmin },
}));

const connectDB = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

const RCAFind = vi.hoisted(() => vi.fn());
const RCAAggregate = vi.hoisted(() => vi.fn());
vi.mock("@/models/RecurringChargeAttempt", () => ({
  default: { find: RCAFind, aggregate: RCAAggregate },
  __esModule: true,
}));

const HostingFind = vi.hoisted(() => vi.fn());
vi.mock("@/models/Hosting", () => ({
  default: { find: HostingFind },
  __esModule: true,
}));

const UserFind = vi.hoisted(() => vi.fn());
vi.mock("@/models/User", () => ({
  default: { find: UserFind },
  __esModule: true,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest } = await vi.importActual<typeof import("next/server")>("next/server");

import { GET } from "@/app/api/admin/recurring-charges/route";

function makeReq(query = "") {
  return new NextRequest(`https://example.com/api/admin/recurring-charges${query ? "?" + query : ""}`, {
    method: "GET",
  });
}

function chainable<T>(result: T) {
  // Mongoose's `find(...).sort(...).limit(...).lean()` chain; each step
  // returns `this`; `lean()` resolves to the data.
  const obj = {
    sort: () => obj,
    limit: () => obj,
    select: () => obj,
    lean: () => Promise.resolve(result),
  };
  return obj;
}

beforeEach(() => {
  isAdmin.mockReset().mockResolvedValue(true);
  connectDB.mockReset().mockResolvedValue(undefined);
  RCAFind.mockReset().mockReturnValue(chainable([]));
  RCAAggregate.mockReset().mockResolvedValue([]);
  HostingFind.mockReset().mockReturnValue(chainable([]));
  UserFind.mockReset().mockReturnValue(chainable([]));
});

describe("GET /api/admin/recurring-charges", () => {
  it("403 when caller is not admin (no DB touched)", async () => {
    isAdmin.mockResolvedValueOnce(false);
    const res = await GET(makeReq());
    expect(res.status).toBe(403);
    expect(connectDB).not.toHaveBeenCalled();
    expect(RCAFind).not.toHaveBeenCalled();
  });

  it("default window is 7d; status filter optional", async () => {
    await GET(makeReq());
    const filter = RCAFind.mock.calls[0][0];
    expect(filter).toMatchObject({ createdAt: { $gte: expect.any(Date) } });
    expect(filter.status).toBeUndefined();
    // Check the window is approximately 7 days back
    const sinceMs = (filter.createdAt as { $gte: Date }).$gte.getTime();
    const diffDays = (Date.now() - sinceMs) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeGreaterThan(6.9);
    expect(diffDays).toBeLessThan(7.1);
  });

  it("applies status filter when valid", async () => {
    await GET(makeReq("status=abandoned"));
    const filter = RCAFind.mock.calls[0][0];
    expect(filter.status).toBe("abandoned");
  });

  it("ignores invalid status filter (defaults to no filter)", async () => {
    await GET(makeReq("status=garbage"));
    const filter = RCAFind.mock.calls[0][0];
    expect(filter.status).toBeUndefined();
  });

  it("respects 24h window param", async () => {
    await GET(makeReq("window=24h"));
    const filter = RCAFind.mock.calls[0][0];
    const sinceMs = (filter.createdAt as { $gte: Date }).$gte.getTime();
    const diffHours = (Date.now() - sinceMs) / (60 * 60 * 1000);
    expect(diffHours).toBeGreaterThan(23.9);
    expect(diffHours).toBeLessThan(24.1);
  });

  it("joins attempts with Hosting (domainName) + User (email) for the table response", async () => {
    const now = new Date();
    RCAFind.mockReturnValueOnce(
      chainable([
        {
          _id: { toString: () => "att1" },
          hostingId: { toString: () => "h1" },
          userId: { toString: () => "u1" },
          customerId: "cust_X",
          tokenId: "token_X",
          amountInRupees: 599.88,
          dueDate: now,
          attemptCount: 2,
          status: "failed",
          nextAttemptAt: now,
          lastAttemptAt: now,
          lastError: "Card declined",
          razorpayPaymentId: null,
          razorpayOrderId: null,
          createdAt: now,
        },
      ])
    );
    HostingFind.mockReturnValueOnce(
      chainable([{ _id: { toString: () => "h1" }, domainName: "example.com", status: "active" }])
    );
    UserFind.mockReturnValueOnce(
      chainable([
        {
          _id: { toString: () => "u1" },
          email: "user@x.com",
          firstName: "Test",
          lastName: "User",
        },
      ])
    );

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      id: "att1",
      hostingId: "h1",
      domainName: "example.com",
      userEmail: "user@x.com",
      userName: "Test User",
      amountInRupees: 599.88,
      attemptCount: 2,
      status: "failed",
      lastError: "Card declined",
    });
  });

  it("aggregate counts come from RCAAggregate, span the whole window (not the filter)", async () => {
    RCAAggregate.mockResolvedValueOnce([
      { _id: "succeeded", count: 12 },
      { _id: "failed", count: 3 },
      { _id: "abandoned", count: 1 },
    ]);
    const res = await GET(makeReq("status=failed"));  // filter by 'failed' but counts span all statuses
    const body = await res.json();
    expect(body.counts).toEqual({
      pending: 0,
      in_progress: 0,
      succeeded: 12,
      failed: 3,
      abandoned: 1,
    });
  });

  it("hasMore=true when row count hits the limit (default 100)", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      _id: { toString: () => `att${i}` },
      hostingId: { toString: () => "h1" },
      userId: { toString: () => "u1" },
      customerId: "c",
      tokenId: "t",
      amountInRupees: 100,
      dueDate: new Date(),
      attemptCount: 1,
      status: "pending",
      createdAt: new Date(),
    }));
    RCAFind.mockReturnValueOnce(chainable(rows));
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.hasMore).toBe(true);
  });

  it("missing Hosting/User row → row still returned with '(deleted)' placeholders", async () => {
    const now = new Date();
    RCAFind.mockReturnValueOnce(
      chainable([
        {
          _id: { toString: () => "att2" },
          hostingId: { toString: () => "hX" },
          userId: { toString: () => "uX" },
          customerId: "c",
          tokenId: "t",
          amountInRupees: 50,
          dueDate: now,
          attemptCount: 1,
          status: "abandoned",
          createdAt: now,
        },
      ])
    );
    HostingFind.mockReturnValueOnce(chainable([]));
    UserFind.mockReturnValueOnce(chainable([]));

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.rows[0]).toMatchObject({
      domainName: "(deleted)",
      userEmail: "(deleted)",
    });
  });
});
