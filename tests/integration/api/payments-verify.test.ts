/**
 * Route-level integration tests for POST /api/payments/verify.
 *
 * Run against a real in-memory MongoDB (mongodb-memory-server) so the
 * order-lookup + early-exit paths exercise actual queries, not mocks.
 * External-network collaborators (Razorpay SDK, Email, Cloud Tasks)
 * are mocked at the module boundary — we're testing the route's
 * decision tree, not Razorpay's network behaviour.
 *
 * Scope of this suite: the deterministic, security-critical paths
 * that the route walks BEFORE the heavy createCompletedOrder() branch.
 * Those paths catch:
 *   1. Auth gate (no user → 401).
 *   2. Body validation (missing payment-verification data / cart → 400).
 *   3. Signature-verification gate (tampered signature → 400).
 *   4. Already-completed idempotency exit (existing Order with status:
 *      "completed" or "paid" → 200 with `orderId`, no new work).
 *
 * The full happy-path provisioning flow (createCompletedOrder branch)
 * touches DA / ResellerClub / Zoho / Cloud Tasks — covered by the unit
 * suites in tests/unit/lib/** that exercise each helper directly.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import { clearAllCollections } from "../setup";

// ── Module-level mocks ──────────────────────────────────────────────────────
//
// AuthService is the first gate the route hits. vi.hoisted so the spy
// hooks survive module reloads between tests.
const { mockGetUserFromRequest } = vi.hoisted(() => ({
  mockGetUserFromRequest: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  AuthService: {
    getUserFromRequest: mockGetUserFromRequest,
    isAdmin: vi.fn(async () => false),
  },
}));

// Razorpay SDK — never let it hit the real API. The mock returns whatever
// the test sets up in `mockRazorpayPaymentDetails` for `payments.fetch()`.
const { mockRazorpayPaymentDetails } = vi.hoisted(() => ({
  mockRazorpayPaymentDetails: { current: null as null | Record<string, unknown> },
}));
vi.mock("razorpay", () => {
  function MockRazorpay(this: Record<string, unknown>) {
    this.orders = { create: vi.fn(), fetch: vi.fn() };
    this.payments = {
      fetch: vi.fn(async (_id: string) => mockRazorpayPaymentDetails.current),
      refund: vi.fn(),
    };
    this.subscriptions = { create: vi.fn(), fetch: vi.fn(), cancel: vi.fn() };
    this.plans = { create: vi.fn(), fetch: vi.fn() };
  }
  return { default: MockRazorpay };
});

// Stub the heavy chained collaborators — these are exercised by their own
// unit suites; the route's responsibility is to dispatch correctly to them.
vi.mock("@/lib/services/payment/renewal", () => ({
  handleRenewalPayment: vi.fn(async () => null),
}));
vi.mock("@/lib/services/payment/post-tasks", () => ({
  createZohoInvoice: vi.fn(async () => ({ invoiceNumber: "INV-TEST-1" })),
  runPostPaymentTasks: vi.fn(async () => undefined),
}));
vi.mock("@/lib/services/payment/order-creator", () => ({
  validateNoRestrictedDomains: vi.fn(() => ({ ok: true })),
  createCompletedOrder: vi.fn(async () => {
    throw new Error("createCompletedOrder should not be reached in this suite");
  }),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/payments/verify/route";
import Order from "@/models/Order";

// ── Helpers ─────────────────────────────────────────────────────────────────

const RAZORPAY_SECRET = "rzp_test_secret";

/** Build a valid HMAC signature for an order-flow payment. */
function signOrderPayment(orderId: string, paymentId: string): string {
  return crypto
    .createHmac("sha256", RAZORPAY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
}

/** A minimal authenticated user double. The route reads `_id` + `email`. */
function authenticatedUser() {
  return {
    _id: "507f1f77bcf86cd799439011",
    email: "user@example.com",
    firstName: "Test",
    lastName: "User",
    isActive: true,
  };
}

/** Build a NextRequest with a JSON body — the route reads via `request.json()`. */
function makeRequest(body: unknown): NextRequest {
  return new NextRequest("https://example.com/api/payments/verify", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

beforeAll(() => {
  // The mocked Razorpay payment's default success shape — tests can override.
  mockRazorpayPaymentDetails.current = {
    id: "pay_test_123",
    order_id: "order_test_999",
    amount: 109900, // ₹1099 in paise
    currency: "INR",
    status: "captured",
    captured: true,
  };
});

beforeEach(async () => {
  await clearAllCollections();
  mockGetUserFromRequest.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/payments/verify — auth gate", () => {
  it("returns 401 when AuthService can't resolve a user", async () => {
    mockGetUserFromRequest.mockResolvedValueOnce(null);

    const res = await POST(
      makeRequest({
        razorpay_order_id: "order_test_999",
        razorpay_payment_id: "pay_test_123",
        razorpay_signature: "irrelevant",
        cartItems: [{ domainName: "example.com", price: 1099, registrationPeriod: 1 }],
      })
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });
});

describe("POST /api/payments/verify — body validation", () => {
  beforeEach(() => mockGetUserFromRequest.mockResolvedValue(authenticatedUser()));

  it("400s when neither razorpay_order_id nor razorpay_subscription_id is present", async () => {
    const res = await POST(
      makeRequest({
        razorpay_payment_id: "pay_test_123",
        razorpay_signature: "x",
        cartItems: [{ domainName: "example.com", price: 1099, registrationPeriod: 1 }],
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Payment verification data/);
  });

  it("400s when razorpay_payment_id is missing", async () => {
    const res = await POST(
      makeRequest({
        razorpay_order_id: "order_test_999",
        razorpay_signature: "x",
        cartItems: [{ domainName: "example.com", price: 1099, registrationPeriod: 1 }],
      })
    );
    expect(res.status).toBe(400);
  });

  it("400s when razorpay_signature is missing", async () => {
    const res = await POST(
      makeRequest({
        razorpay_order_id: "order_test_999",
        razorpay_payment_id: "pay_test_123",
        cartItems: [{ domainName: "example.com", price: 1099, registrationPeriod: 1 }],
      })
    );
    expect(res.status).toBe(400);
  });

  it("400s when cartItems is missing", async () => {
    const res = await POST(
      makeRequest({
        razorpay_order_id: "order_test_999",
        razorpay_payment_id: "pay_test_123",
        razorpay_signature: "x",
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Cart items/);
  });

  it("400s when cartItems is empty", async () => {
    const res = await POST(
      makeRequest({
        razorpay_order_id: "order_test_999",
        razorpay_payment_id: "pay_test_123",
        razorpay_signature: "x",
        cartItems: [],
      })
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/payments/verify — signature gate", () => {
  beforeEach(() => mockGetUserFromRequest.mockResolvedValue(authenticatedUser()));

  it("rejects a tampered signature even with otherwise-valid body", async () => {
    const res = await POST(
      makeRequest({
        razorpay_order_id: "order_test_999",
        razorpay_payment_id: "pay_test_123",
        razorpay_signature: "tampered_signature_value",
        cartItems: [{ domainName: "example.com", price: 1099, registrationPeriod: 1 }],
      })
    );

    // verifyRazorpayPayment returns a 400-class response — exact status is
    // 400 per the underlying service; assert non-2xx.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe("POST /api/payments/verify — already-completed idempotency", () => {
  beforeEach(() => mockGetUserFromRequest.mockResolvedValue(authenticatedUser()));

  it("returns 200 with the existing orderId when an Order with status 'completed' exists", async () => {
    // Seed a completed order keyed by the razorpay_order_id we're about to verify.
    const razorpayOrderId = "order_test_completed_777";
    const paymentId = "pay_test_completed_777";

    // Razorpay's payments.fetch returns the authoritative order_id; the
    // verifier cross-checks it against the client claim, so the mock has to
    // echo the same id for this test.
    mockRazorpayPaymentDetails.current = {
      id: paymentId,
      order_id: razorpayOrderId,
      amount: 109900,
      currency: "INR",
      status: "captured",
      captured: true,
    };

    await Order.create({
      orderId: "ORD-EXISTING-COMPLETED",
      userId: "507f1f77bcf86cd799439011",
      userName: "Test User",
      userEmail: "user@example.com",
      paymentId,
      razorpayOrderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: "x".repeat(64),
      amount: 1099,
      currency: "INR",
      status: "completed",
      domains: [
        {
          domainName: "example.com",
          price: 1099,
          currency: "INR",
          registrationPeriod: 1,
          status: "registered",
          bookingStatus: [],
        },
      ],
      successfulDomains: ["example.com"],
      paymentVerification: {
        verifiedAt: new Date(),
        paymentStatus: "captured",
        paymentAmount: 1099,
        paymentCurrency: "INR",
        razorpayOrderId,
      },
    });

    const res = await POST(
      makeRequest({
        razorpay_order_id: razorpayOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signOrderPayment(razorpayOrderId, paymentId),
        cartItems: [{ domainName: "example.com", price: 1099, registrationPeriod: 1 }],
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.orderId).toBe("ORD-EXISTING-COMPLETED");
    expect(body.message).toMatch(/already completed/i);
  });

  it("returns 200 with provisioning-in-progress message when status is 'paid'", async () => {
    const razorpayOrderId = "order_test_paid_888";
    const paymentId = "pay_test_paid_888";

    mockRazorpayPaymentDetails.current = {
      id: paymentId,
      order_id: razorpayOrderId,
      amount: 109900,
      currency: "INR",
      status: "captured",
      captured: true,
    };

    await Order.create({
      orderId: "ORD-EXISTING-PAID",
      userId: "507f1f77bcf86cd799439011",
      userName: "Test User",
      userEmail: "user@example.com",
      paymentId,
      razorpayOrderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: "x".repeat(64),
      amount: 1099,
      currency: "INR",
      status: "paid",
      domains: [
        {
          domainName: "example.com",
          price: 1099,
          currency: "INR",
          registrationPeriod: 1,
          status: "pending",
          bookingStatus: [],
        },
      ],
      successfulDomains: [],
      paymentVerification: {
        verifiedAt: new Date(),
        paymentStatus: "captured",
        paymentAmount: 1099,
        paymentCurrency: "INR",
        razorpayOrderId,
      },
    });

    const res = await POST(
      makeRequest({
        razorpay_order_id: razorpayOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signOrderPayment(razorpayOrderId, paymentId),
        cartItems: [{ domainName: "example.com", price: 1099, registrationPeriod: 1 }],
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.orderId).toBe("ORD-EXISTING-PAID");
    expect(body.domainRegistrationStatus).toBe("processing");
  });

  it("returns the same in-progress response for status 'processing' (idempotency must cover both)", async () => {
    const razorpayOrderId = "order_test_processing";
    const paymentId = "pay_test_processing";

    mockRazorpayPaymentDetails.current = {
      id: paymentId,
      order_id: razorpayOrderId,
      amount: 109900,
      currency: "INR",
      status: "captured",
      captured: true,
    };

    await Order.create({
      orderId: "ORD-EXISTING-PROCESSING",
      userId: "507f1f77bcf86cd799439011",
      userName: "Test User",
      userEmail: "user@example.com",
      paymentId,
      razorpayOrderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: "x".repeat(64),
      amount: 1099,
      currency: "INR",
      status: "processing",
      domains: [
        {
          domainName: "example.com",
          price: 1099,
          currency: "INR",
          registrationPeriod: 1,
          status: "processing",
          bookingStatus: [],
        },
      ],
      successfulDomains: [],
      paymentVerification: {
        verifiedAt: new Date(),
        paymentStatus: "captured",
        paymentAmount: 1099,
        paymentCurrency: "INR",
        razorpayOrderId,
      },
    });

    const res = await POST(
      makeRequest({
        razorpay_order_id: razorpayOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signOrderPayment(razorpayOrderId, paymentId),
        cartItems: [{ domainName: "example.com", price: 1099, registrationPeriod: 1 }],
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orderId).toBe("ORD-EXISTING-PROCESSING");
    expect(body.domainRegistrationStatus).toBe("processing");
  });
});
