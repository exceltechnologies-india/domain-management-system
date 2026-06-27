/**
 * Tests for `app/api/admin/renewals/route.ts` — the cross-mode
 * upcoming-renewals dashboard feed.
 *
 * Pins:
 *  - 403 when caller is not admin (anti-info-leak; no DB touched)
 *  - Default window 30d; valid window params respected
 *  - Mode filter: tokens / subscriptions / manual classification
 *  - chargeDate = expiryDate - 1d for Tokens; = expiryDate otherwise
 *  - mandateMode discriminator preserves "tokens wins when both IDs set"
 *  - Aggregate counts span the whole window (not the filtered slice)
 *  - Joins each row with User (email/name) + HostingPlan (price/name)
 *  - 'pending' / 'terminated' / 'failed' status rows excluded
 *  - hasMore=true when row count hits the limit
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const isAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { isAdmin },
}));

const connectDB = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

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

const PlanFind = vi.hoisted(() => vi.fn());
vi.mock("@/models/HostingPlan", () => ({
  default: { find: PlanFind },
  __esModule: true,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest } = await vi.importActual<typeof import("next/server")>("next/server");

import { GET } from "@/app/api/admin/renewals/route";

function chainable<T>(result: T) {
  const obj = {
    sort: () => obj,
    limit: () => obj,
    select: () => obj,
    lean: () => Promise.resolve(result),
  };
  return obj;
}

function makeReq(query = "") {
  return new NextRequest(
    `https://example.com/api/admin/renewals${query ? "?" + query : ""}`,
    { method: "GET" }
  );
}

beforeEach(() => {
  isAdmin.mockReset().mockResolvedValue(true);
  connectDB.mockReset().mockResolvedValue(undefined);
  HostingFind.mockReset().mockReturnValue(chainable([]));
  UserFind.mockReset().mockReturnValue(chainable([]));
  PlanFind.mockReset().mockReturnValue(chainable([]));
});

describe("GET /api/admin/renewals", () => {
  it("403 when caller is not admin (no DB touched)", async () => {
    isAdmin.mockResolvedValueOnce(false);
    const res = await GET(makeReq());
    expect(res.status).toBe(403);
    expect(connectDB).not.toHaveBeenCalled();
    expect(HostingFind).not.toHaveBeenCalled();
  });

  it("default window is 30d — filter excludes pending/terminated/failed; expiryDate <= now+30d", async () => {
    await GET(makeReq());
    const filter = HostingFind.mock.calls[0][0];
    expect(filter.status).toMatchObject({ $in: ["active", "expired"] });
    const cutoff = (filter.expiryDate as { $lte: Date }).$lte.getTime();
    const diffDays = (cutoff - Date.now()) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeGreaterThan(29.9);
    expect(diffDays).toBeLessThan(30.1);
  });

  it("respects 7d / 90d window params", async () => {
    await GET(makeReq("window=7d"));
    const filter7d = HostingFind.mock.calls[0][0];
    const cutoff7 = (filter7d.expiryDate as { $lte: Date }).$lte.getTime();
    expect((cutoff7 - Date.now()) / (24 * 60 * 60 * 1000)).toBeGreaterThan(6.9);

    HostingFind.mockClear();
    HostingFind.mockReturnValue(chainable([]));
    await GET(makeReq("window=90d"));
    const filter90d = HostingFind.mock.calls[0][0];
    const cutoff90 = (filter90d.expiryDate as { $lte: Date }).$lte.getTime();
    expect((cutoff90 - Date.now()) / (24 * 60 * 60 * 1000)).toBeGreaterThan(89.9);
  });

  it("invalid window param falls back to 30d default", async () => {
    await GET(makeReq("window=garbage"));
    const filter = HostingFind.mock.calls[0][0];
    const cutoff = (filter.expiryDate as { $lte: Date }).$lte.getTime();
    const diffDays = (cutoff - Date.now()) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeGreaterThan(29.9);
    expect(diffDays).toBeLessThan(30.1);
  });

  it("mode=tokens filter requires razorpayTokenId present", async () => {
    await GET(makeReq("mode=tokens"));
    const filter = HostingFind.mock.calls[0][0];
    expect(filter.razorpayTokenId).toMatchObject({ $exists: true });
  });

  it("mode=subscriptions filter requires subscriptionId present + razorpayTokenId absent", async () => {
    await GET(makeReq("mode=subscriptions"));
    const filter = HostingFind.mock.calls[0][0];
    expect(filter.subscriptionId).toMatchObject({ $exists: true });
    // Token must be unset for the Subscriptions branch to win
    expect(filter.razorpayTokenId).toMatchObject({ $in: expect.any(Array) });
  });

  it("mode=manual filter requires BOTH IDs absent", async () => {
    await GET(makeReq("mode=manual"));
    const filter = HostingFind.mock.calls[0][0];
    expect(filter.razorpayTokenId).toMatchObject({ $in: expect.any(Array) });
    expect(filter.subscriptionId).toMatchObject({ $in: expect.any(Array) });
  });

  it("invalid mode param ignored (no mode filter applied)", async () => {
    await GET(makeReq("mode=garbage"));
    const filter = HostingFind.mock.calls[0][0];
    expect(filter.razorpayTokenId).toBeUndefined();
    expect(filter.subscriptionId).toBeUndefined();
  });

  it("Tokens-flow row: chargeDate = expiryDate - 1 day; mandateMode='tokens'", async () => {
    const expiry = new Date("2026-08-01T00:00:00.000Z");
    HostingFind
      .mockReturnValueOnce(chainable([
        {
          _id: { toString: () => "H1" },
          domainName: "tok.example.com",
          userId: { toString: () => "U1" },
          status: "active",
          expiryDate: expiry,
          planId: "starter",
          isTrial: false,
          razorpayCustomerId: "cust_X",
          razorpayTokenId: "token_X",
          subscriptionId: null,
        },
      ]))
      .mockReturnValueOnce(chainable([])); // aggregate-counts query

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].mandateMode).toBe("tokens");
    const charge = new Date(body.rows[0].chargeDate).getTime();
    const diffDays = (expiry.getTime() - charge) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeCloseTo(1, 5); // expiry - 1 day
  });

  it("Subscriptions-flow row: chargeDate = expiryDate; mandateMode='subscriptions'", async () => {
    const expiry = new Date("2026-08-01T00:00:00.000Z");
    HostingFind
      .mockReturnValueOnce(chainable([
        {
          _id: { toString: () => "H2" },
          domainName: "sub.example.com",
          userId: { toString: () => "U1" },
          status: "active",
          expiryDate: expiry,
          planId: "starter",
          isTrial: false,
          subscriptionId: "sub_X",
          razorpayTokenId: null,
        },
      ]))
      .mockReturnValueOnce(chainable([]));

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.rows[0].mandateMode).toBe("subscriptions");
    expect(body.rows[0].chargeDate).toBe(expiry.toISOString());
  });

  it("Manual row: chargeDate = expiryDate; mandateMode='manual'", async () => {
    const expiry = new Date("2026-08-01T00:00:00.000Z");
    HostingFind
      .mockReturnValueOnce(chainable([
        {
          _id: { toString: () => "H3" },
          domainName: "manual.example.com",
          userId: { toString: () => "U1" },
          status: "active",
          expiryDate: expiry,
          planId: "starter",
          subscriptionId: null,
          razorpayTokenId: null,
        },
      ]))
      .mockReturnValueOnce(chainable([]));

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.rows[0].mandateMode).toBe("manual");
    expect(body.rows[0].chargeDate).toBe(expiry.toISOString());
  });

  it("BOTH razorpayTokenId AND subscriptionId set → 'tokens' wins (migrated-customer edge case)", async () => {
    const expiry = new Date("2026-08-01T00:00:00.000Z");
    HostingFind
      .mockReturnValueOnce(chainable([
        {
          _id: { toString: () => "H4" },
          domainName: "migrated.example.com",
          userId: { toString: () => "U1" },
          status: "active",
          expiryDate: expiry,
          planId: "starter",
          subscriptionId: "sub_OLD",
          razorpayTokenId: "token_NEW",
        },
      ]))
      .mockReturnValueOnce(chainable([]));

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.rows[0].mandateMode).toBe("tokens");
  });

  it("joins each row with User (email/name) + HostingPlan (name/price/currency)", async () => {
    const expiry = new Date("2026-08-01T00:00:00.000Z");
    HostingFind
      .mockReturnValueOnce(chainable([
        {
          _id: { toString: () => "H1" },
          domainName: "alice.example.com",
          userId: { toString: () => "U1" },
          status: "active",
          expiryDate: expiry,
          planId: "starter",
          razorpayTokenId: "token_X",
          razorpayCustomerId: "cust_X",
        },
      ]))
      .mockReturnValueOnce(chainable([]));
    UserFind.mockReturnValueOnce(
      chainable([
        {
          _id: { toString: () => "U1" },
          email: "alice@example.com",
          firstName: "Alice",
          lastName: "Smith",
        },
      ])
    );
    PlanFind.mockReturnValueOnce(
      chainable([
        { planId: "starter", name: "Starter Yearly", price: 599.88, currency: "INR" },
      ])
    );

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.rows[0]).toMatchObject({
      userEmail: "alice@example.com",
      userName: "Alice Smith",
      planName: "Starter Yearly",
      planPrice: 599.88,
      planCurrency: "INR",
    });
  });

  it("aggregate counts span the whole window (not the filtered slice)", async () => {
    // First find() call is the filtered-rows query; second is the
    // aggregate query for counts. The aggregate must run on the whole
    // window even when mode=tokens is the active filter.
    HostingFind
      .mockReturnValueOnce(chainable([])) // filtered slice empty
      .mockReturnValueOnce(
        chainable([
          { razorpayTokenId: "t1", subscriptionId: null },
          { razorpayTokenId: "t2", subscriptionId: null },
          { razorpayTokenId: "t3", subscriptionId: null },
          { razorpayTokenId: null, subscriptionId: "s1" },
          { razorpayTokenId: null, subscriptionId: "s2" },
          { razorpayTokenId: null, subscriptionId: null },
        ])
      );
    const res = await GET(makeReq("mode=tokens"));
    const body = await res.json();
    expect(body.counts).toEqual({ tokens: 3, subscriptions: 2, manual: 1 });
  });

  it("missing User / Plan join → row still returned with sane defaults", async () => {
    HostingFind
      .mockReturnValueOnce(chainable([
        {
          _id: { toString: () => "H1" },
          domainName: "orphan.example.com",
          userId: { toString: () => "U_GONE" },
          status: "active",
          expiryDate: new Date(),
          planId: "missing_plan",
          razorpayTokenId: null,
          subscriptionId: null,
        },
      ]))
      .mockReturnValueOnce(chainable([]));
    UserFind.mockReturnValueOnce(chainable([])); // user missing
    PlanFind.mockReturnValueOnce(chainable([])); // plan missing

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.rows[0]).toMatchObject({
      userEmail: "(deleted)",
      planPrice: null,
      planCurrency: "INR",
    });
  });

  it("hasMore=true when row count hits the limit (default 100)", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      _id: { toString: () => `H${i}` },
      domainName: `d${i}.example.com`,
      userId: { toString: () => "U1" },
      status: "active",
      expiryDate: new Date(),
      planId: "starter",
      razorpayTokenId: null,
      subscriptionId: null,
    }));
    HostingFind
      .mockReturnValueOnce(chainable(rows))
      .mockReturnValueOnce(chainable([]));

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.hasMore).toBe(true);
    expect(body.rows.length).toBe(100);
  });
});
