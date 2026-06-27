/**
 * Tests for `app/api/admin/integration-health/route.ts` — narrow scope:
 * pins the new RecurringChargeAttempt source (Phase 2I admin-UI Finding 4)
 * + the new Razorpay-recurring signature/hint classification.
 *
 * Pre-existing sources (Order error scan + Zoho stuck invoice scan +
 * SystemLog scan) aren't tested here — they were untested before this
 * file existed, and adding coverage for them is its own effort.
 *
 * Pins for the new source:
 *  - 401 when caller isn't admin (gate works)
 *  - Failed RecurringChargeAttempt → razorpay provider card with the
 *    correct hint (points operator at /admin/recurring-charges)
 *  - Abandoned RecurringChargeAttempt → razorpay provider card with the
 *    distinct "ABANDONED" hint (mentions DA-suspended + customer needs
 *    to re-subscribe)
 *  - Similar errors cluster (count > 1) via bucketKey normalisation
 *  - RCA query failure does NOT crash the whole route (caught + logged)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const connectDB = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

// The route imports Order + SystemLog at top-level; we mock both with
// chainable `find().sort().limit().lean()` returning empty so this test
// only exercises the new RCA branch.
const OrderFind = vi.hoisted(() => vi.fn());
vi.mock("@/models/Order", () => ({ default: { find: OrderFind }, __esModule: true }));

const SystemLogFind = vi.hoisted(() => vi.fn());
vi.mock("@/models/SystemLog", () => ({ default: { find: SystemLogFind }, __esModule: true }));

// The route uses dynamic import for RecurringChargeAttempt; mock the
// default export to surface our test data on .find().sort().limit().lean().
const RCAFind = vi.hoisted(() => vi.fn());
vi.mock("@/models/RecurringChargeAttempt", () => ({
  default: { find: RCAFind },
  __esModule: true,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest } = await vi.importActual<typeof import("next/server")>(
  "next/server"
);

import { GET } from "@/app/api/admin/integration-health/route";

function chainable<T>(result: T) {
  const obj = {
    sort: () => obj,
    limit: () => obj,
    lean: () => Promise.resolve(result),
  };
  return obj;
}

function makeReq(query = "") {
  return new NextRequest(
    `https://example.com/api/admin/integration-health${query ? "?" + query : ""}`,
    { method: "GET" }
  );
}

beforeEach(() => {
  getAdminFromRequest.mockReset().mockResolvedValue({ id: "U_ADMIN", role: "admin" });
  connectDB.mockReset().mockResolvedValue(undefined);
  // Default: all sources empty
  OrderFind.mockReset().mockReturnValue(chainable([]));
  SystemLogFind.mockReset().mockReturnValue(chainable([]));
  RCAFind.mockReset().mockReturnValue(chainable([]));
});

describe("/api/admin/integration-health — RecurringChargeAttempt source", () => {
  it("401 when caller isn't admin (no DB touched)", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    expect(connectDB).not.toHaveBeenCalled();
    expect(RCAFind).not.toHaveBeenCalled();
  });

  it("failed RecurringChargeAttempt → razorpay provider card with retry-scheduled hint", async () => {
    const now = new Date();
    RCAFind.mockReturnValueOnce(
      chainable([
        {
          _id: { toString: () => "att1" },
          status: "failed",
          attemptCount: 2,
          lastError: "Card declined",
          hostingId: { toString: () => "host_abcd1234" },
          createdAt: now,
          dueDate: now,
        },
      ])
    );
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    const razorpay = body.providers.find(
      (p: { id: string; totalErrors: number; patterns: Array<{ hint?: string }> }) =>
        p.id === "razorpay"
    );
    expect(razorpay).toBeDefined();
    expect(razorpay.totalErrors).toBe(1);
    expect(razorpay.patterns[0].hint).toMatch(/retried per the \[T\+1, T\+3, T\+7\]/);
  });

  it("abandoned RecurringChargeAttempt → razorpay provider card with abandonment hint", async () => {
    const now = new Date();
    RCAFind.mockReturnValueOnce(
      chainable([
        {
          _id: { toString: () => "att2" },
          status: "abandoned",
          attemptCount: 4,
          lastError: "Mandate revoked by customer",
          hostingId: { toString: () => "host_xyz98765" },
          createdAt: now,
          abandonedAt: now,
          dueDate: now,
        },
      ])
    );
    const res = await GET(makeReq());
    const body = await res.json();
    const razorpay = body.providers.find(
      (p: { id: string; totalErrors: number; patterns: Array<{ hint?: string; exemplarMessage: string }> }) =>
        p.id === "razorpay"
    );
    expect(razorpay.totalErrors).toBe(1);
    expect(razorpay.patterns[0].exemplarMessage).toMatch(/\[RECURRING-CHARGE\] ABANDONED/);
    expect(razorpay.patterns[0].hint).toMatch(/abandoned after 4 failed attempts/);
    expect(razorpay.patterns[0].hint).toMatch(/\/admin\/recurring-charges/);
  });

  it("similar errors cluster via bucketKey normalisation (count > 1)", async () => {
    const now = new Date();
    RCAFind.mockReturnValueOnce(
      chainable([
        {
          _id: { toString: () => "att_a" },
          status: "abandoned",
          attemptCount: 4,
          lastError: "Mandate revoked by customer",
          hostingId: { toString: () => "host_111" },
          createdAt: now,
          dueDate: now,
        },
        {
          _id: { toString: () => "att_b" },
          status: "abandoned",
          attemptCount: 4,
          lastError: "Mandate revoked by customer",
          hostingId: { toString: () => "host_222" },
          createdAt: now,
          dueDate: now,
        },
        {
          _id: { toString: () => "att_c" },
          status: "abandoned",
          attemptCount: 4,
          lastError: "Mandate revoked by customer",
          hostingId: { toString: () => "host_333" },
          createdAt: now,
          dueDate: now,
        },
      ])
    );
    const res = await GET(makeReq());
    const body = await res.json();
    const razorpay = body.providers.find((p: { id: string }) => p.id === "razorpay");
    expect(razorpay.totalErrors).toBe(3);
    // All 3 attempts have identical lastError → bucketKey collides → one pattern row
    expect(razorpay.patterns).toHaveLength(1);
    expect(razorpay.patterns[0].count).toBe(3);
  });

  it("RCA query failure does NOT crash the route (existing sources still rendered)", async () => {
    RCAFind.mockImplementationOnce(() => {
      throw new Error("Mongo connection lost");
    });
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    // Razorpay card exists in providers array but has 0 errors (RCA source threw)
    const razorpay = body.providers.find((p: { id: string }) => p.id === "razorpay");
    expect(razorpay).toBeDefined();
    expect(razorpay.totalErrors).toBe(0);
  });
});
