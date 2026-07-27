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

// Source 6: Hostings with a durable lastProvisionError (dynamic-imported).
const HostingFind = vi.hoisted(() => vi.fn());
vi.mock("@/models/Hosting", () => ({
  default: { find: HostingFind },
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
  HostingFind.mockReset().mockReturnValue(chainable([]));
});

describe("/api/admin/integration-health — RecurringChargeAttempt source", () => {
  it("401 when caller isn't admin (no DB touched)", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    expect(connectDB).not.toHaveBeenCalled();
    expect(RCAFind).not.toHaveBeenCalled();
  });

  it("failed RecurringChargeAttempt → razorpay provider card with unified-policy hint (legacy 'failed' status pre-hard-1-attempt-rule)", async () => {
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
    // Hint now describes the unified hard 1-attempt policy — `failed`
    // rows shouldn't normally exist (all fails go straight to `abandoned`)
    // but the signature still classifies them if a legacy row appears.
    expect(razorpay.patterns[0].hint).toMatch(/hard 1-attempt policy/i);
  });

  it("order with mandateRefundStatus='failed' → razorpay card with [MANDATE-REFUND] hint + affectedOrder context", async () => {
    const now = new Date();
    // Order.find calls in route order: (1) failed-domains, (2) zoho-stuck,
    // (3) mandate-refund-failed. Inject empty for the first two, data for #3.
    OrderFind.mockReset()
      .mockReturnValueOnce(chainable([])) // failed domains
      .mockReturnValueOnce(chainable([])) // zoho creation_failed
      .mockReturnValueOnce(
        chainable([
          {
            orderId: "ord_trial_1",
            userEmail: "trial@x.com",
            userName: "Trial User",
            amount: 2,
            createdAt: now,
            razorpayPaymentId: "pay_STUCK2",
          },
        ])
      );
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    const razorpay = body.providers.find(
      (p: { id: string }) => p.id === "razorpay"
    );
    expect(razorpay).toBeDefined();
    expect(razorpay.totalErrors).toBe(1);
    const pattern = razorpay.patterns[0];
    expect(pattern.hint).toMatch(/mandate-validation charge was NOT refunded/i);
    expect(pattern.affectedOrders[0]).toMatchObject({
      orderId: "ord_trial_1",
      userEmail: "trial@x.com",
      amount: 2,
    });
    expect(pattern.exemplarMessage).toContain("pay_STUCK2");
  });

  it("Hosting with lastProvisionError → DirectAdmin card with the specific DA hint + domain context", async () => {
    const now = new Date();
    HostingFind.mockReturnValueOnce(
      chainable([
        {
          domainName: "stuck.com",
          orderId: "ord_stuck",
          lastProvisionError: "Cannot Create Account - That IP does not exist in your list",
          lastProvisionErrorAt: now,
          lastProvisionOutcome: "hard_failure",
        },
      ])
    );
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    const da = body.providers.find((p: { id: string }) => p.id === "directadmin");
    expect(da).toBeDefined();
    expect(da.totalErrors).toBe(1);
    // The raw DA reason matches the "That IP does not exist" signature → its
    // targeted DIRECTADMIN_IP remediation hint, not the generic DA one.
    expect(da.patterns[0].hint).toMatch(/DIRECTADMIN_IP/i);
    expect(da.patterns[0].affectedOrders[0]).toMatchObject({ domainName: "stuck.com" });
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
    // Hint now describes the unified hard 1-attempt rule applied to
    // both trial-conversion AND renewal — pin the rule + the dashboard
    // link so a future regression that drops either signal is caught.
    expect(razorpay.patterns[0].hint).toMatch(/HARD RULE: 1 attempt then suspend/i);
    expect(razorpay.patterns[0].hint).toMatch(/UNIFORMLY to both trial-to-paid conversions AND renewals/i);
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

// ─────────────────── Application provider (post-2026-07-02) ───────────────────
// The `application` bucket was silently broken pre-2026-07-02: `service: 'api'`
// SystemLog entries mapped to a `application` provider id that wasn't seeded
// in providerMap, causing a runtime TypeError swallowed by the outer catch.
// The 7-layer manual-flow-trial chain would have surfaced there if not for
// the seeding bug. These tests pin the fix.

describe("/api/admin/integration-health — WhatsApp provider (2026-07-04)", () => {
  it("SystemLog entry with service='whatsapp' → WhatsApp card, not application", async () => {
    const now = new Date();
    SystemLogFind.mockReturnValueOnce(
      chainable([
        {
          _id: "wa1",
          message: '[WhatsApp] Template "payment_confirmed" failed → +919876543210: {"error":{"code":132001}}',
          source: "Server Logger",
          service: "whatsapp",
          createdAt: now,
        },
      ])
    );
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    const wa = body.providers.find((p: { id: string }) => p.id === "whatsapp");
    expect(wa).toBeDefined();
    expect(wa.totalErrors).toBe(1);
    expect(wa.patterns[0].hint).toMatch(/WhatsApp/i);
    // Must NOT have leaked into the application bucket.
    const app = body.providers.find((p: { id: string }) => p.id === "application");
    expect(app?.totalErrors ?? 0).toBe(0);
  });
});

describe("/api/admin/integration-health — Application provider", () => {
  it("SystemLog entry with service='api' classifies to application card without crashing the route", async () => {
    const now = new Date();
    SystemLogFind.mockReturnValueOnce(
      chainable([
        {
          _id: "sl1",
          message:
            "❌ [CREATE-ORDER] Manual flow failed — falling through to Subscriptions flow: ValidatorError: mandateMode: `manual` is not a valid enum value for path `mandateMode`.",
          source: "Server Logger",
          service: "api",
          createdAt: now,
        },
      ])
    );
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    const application = body.providers.find(
      (p: { id: string }) => p.id === "application"
    );
    expect(application).toBeDefined();
    expect(application.totalErrors).toBe(1);
    // The ValidatorError signature should win → the hint mentions the
    // "add-new-enum-value" lesson from ORDER-MANDATEMODE-MANUAL.
    expect(application.patterns[0].hint).toMatch(/Mongoose schema-layer/i);
    expect(application.patterns[0].hint).toMatch(/enum/i);
  });

  it("[CREATE-ORDER] prefixed error clusters under application with the create-order hint", async () => {
    const now = new Date();
    SystemLogFind.mockReturnValueOnce(
      chainable([
        {
          _id: "sl2",
          message: "❌ [CREATE-ORDER] Razorpay order creation failed: Failed to generate payment targets",
          source: "Server Logger",
          service: "api",
          createdAt: now,
        },
      ])
    );
    const res = await GET(makeReq());
    const body = await res.json();
    const application = body.providers.find(
      (p: { id: string }) => p.id === "application"
    );
    expect(application.totalErrors).toBe(1);
    // "Failed to generate payment targets" wins over the [CREATE-ORDER] tag
    // (both match — first-match-wins order in PROVIDERS[] gives us the
    // targeted hint that names the outer razorpay-catch fall-through).
    expect(application.patterns[0].hint).toMatch(/no-payment-target throw/i);
  });

  it("MongooseError buffering timeout gets the cold-start connectDB hint", async () => {
    const now = new Date();
    SystemLogFind.mockReturnValueOnce(
      chainable([
        {
          _id: "sl3",
          message:
            "MongooseError: Operation `hostings.find()` buffering timed out after 10000ms",
          source: "Server Logger",
          service: "api",
          createdAt: now,
        },
      ])
    );
    const res = await GET(makeReq());
    const body = await res.json();
    const application = body.providers.find(
      (p: { id: string }) => p.id === "application"
    );
    expect(application.totalErrors).toBe(1);
    expect(application.patterns[0].hint).toMatch(/cold-start signature/i);
    expect(application.patterns[0].hint).toMatch(/connectDB/i);
  });

  it("application provider is present in response even when no errors exist (empty card renders green)", async () => {
    // All sources empty (default from beforeEach) → we expect the application
    // card to STILL be in the providers array so the frontend renders it.
    const res = await GET(makeReq());
    const body = await res.json();
    const application = body.providers.find(
      (p: { id: string }) => p.id === "application"
    );
    expect(application).toBeDefined();
    expect(application.totalErrors).toBe(0);
    expect(application.patterns).toHaveLength(0);
  });

  it("**latent crash fix**: unseeded provider id from a bucket routes to `unknown` instead of throwing TypeError", async () => {
    // Simulate a SystemLog entry whose service maps to a provider that
    // wasn't seeded in providerMap. Pre-fix: `providerMap.get(id)!.total…`
    // threw TypeError, whole route 500'd. Post-fix: falls back to unknown.
    // We use `service: "unknown_future_service"` — an unmapped service that
    // triggers the keyword-classify path returning 'unknown' (the safe
    // fallback). The rendering path shouldn't throw regardless.
    const now = new Date();
    SystemLogFind.mockReturnValueOnce(
      chainable([
        {
          _id: "sl4",
          message: "Some totally-unclassified opaque failure text with no signature match",
          source: "Server Logger",
          service: "unknown_future_service",
          createdAt: now,
        },
      ])
    );
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    // The entry should surface under `unknown` (fallback) rather than crash.
    const unknown = body.providers.find((p: { id: string }) => p.id === "unknown");
    expect(unknown).toBeDefined();
    expect(unknown.totalErrors).toBe(1);
  });
});
