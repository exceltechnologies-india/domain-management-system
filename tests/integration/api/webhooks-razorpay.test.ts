/**
 * Route-level integration tests for POST /api/webhooks/razorpay.
 *
 * Webhook is the second of two payment-entry surfaces (the other is
 * /api/payments/verify). It has FIVE security layers in series; each one
 * is tested here as its own gate so a regression in any single layer
 * fails CI before it ships.
 *
 *   Layer 1 — signature verification (HMAC-SHA256 against the body).
 *   Layer 2 — timestamp gate (reject events older than 24 h).
 *   Layer 3 — Redis nonce dedup (idempotency cache for the retry window).
 *   Layer 4 — always 200 once verified (so Razorpay stops retrying).
 *   Layer 5 — generic error message on unhandled exceptions.
 *
 * Plus the event-dispatch table: `subscription.charged` and
 * `subscription.payment_failed` get routed to specific handler functions;
 * everything else is acknowledged silently.
 *
 * The Razorpay SDK + handler functions + redis client are mocked at the
 * module boundary so the route's own decision tree is what's exercised.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";

const WEBHOOK_SECRET = "rzp_test_webhook";

// ── Mocks ───────────────────────────────────────────────────────────────────

// Razorpay SDK stays mocked — verifyWebhookSignature is still real-impl,
// just instantiated without the network.
vi.mock("razorpay", () => {
  function MockRazorpay(this: Record<string, unknown>) {
    this.orders = { create: vi.fn(), fetch: vi.fn() };
    this.payments = { fetch: vi.fn(), refund: vi.fn() };
    this.subscriptions = { create: vi.fn(), fetch: vi.fn(), cancel: vi.fn() };
    this.plans = { create: vi.fn(), fetch: vi.fn() };
  }
  return { default: MockRazorpay };
});

// Spy on the event-dispatch handlers so we can assert which one (if any)
// fired. The actual handler logic is exercised by its own unit tests.
const { mockChargedHandler, mockFailedHandler } = vi.hoisted(() => ({
  mockChargedHandler: vi.fn(async () => undefined),
  mockFailedHandler: vi.fn(async () => undefined),
}));
vi.mock("@/lib/services/payment/webhook-handlers", () => ({
  handleSubscriptionCharged: mockChargedHandler,
  handleSubscriptionFailed: mockFailedHandler,
}));

// Override the global redis stub from setup.ts so individual tests can
// toggle the SET NX result + throw behaviour. The set() signature mirrors
// ioredis: redis.set(key, value, "EX", ttlSeconds, "NX") → "OK" | null.
const { mockRedisSet } = vi.hoisted(() => ({
  mockRedisSet: vi.fn(async () => "OK" as string | null),
}));
vi.mock("@/lib/redis", () => ({
  redis: {
    set: mockRedisSet,
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    ttl: vi.fn(async () => 60),
    get: vi.fn(async () => null),
    del: vi.fn(async () => 1),
  },
  redisCache: {
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    del: vi.fn(async () => undefined),
  },
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/webhooks/razorpay/route";

// ── Helpers ─────────────────────────────────────────────────────────────────

function signBody(body: string, secret: string = WEBHOOK_SECRET): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

function makeWebhookRequest(body: string, signature: string): NextRequest {
  return new NextRequest("https://example.com/api/webhooks/razorpay", {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "x-razorpay-signature": signature,
    },
  });
}

/** Build a `subscription.charged` payload with the right `payload.payment.entity.id` path. */
function chargedPayload(opts: {
  paymentId?: string;
  subscriptionId?: string;
  createdAt?: number;
} = {}): object {
  return {
    event: "subscription.charged",
    created_at: opts.createdAt ?? Math.floor(Date.now() / 1000),
    payload: {
      payment: {
        entity: {
          id: opts.paymentId ?? "pay_charged_111",
          amount: 49900,
          currency: "INR",
          status: "captured",
        },
      },
      subscription: {
        entity: {
          id: opts.subscriptionId ?? "sub_222",
          status: "active",
        },
      },
    },
  };
}

function failedPayload(opts: { paymentId?: string } = {}): object {
  return {
    event: "subscription.payment_failed",
    created_at: Math.floor(Date.now() / 1000),
    payload: {
      payment: {
        entity: {
          id: opts.paymentId ?? "pay_failed_333",
          amount: 49900,
          currency: "INR",
          status: "failed",
        },
      },
    },
  };
}

beforeEach(() => {
  mockChargedHandler.mockReset();
  mockFailedHandler.mockReset();
  mockRedisSet.mockReset();
  mockRedisSet.mockResolvedValue("OK"); // default: nonce claimed cleanly
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Layer 1: signature ──────────────────────────────────────────────────────

describe("POST /api/webhooks/razorpay — Layer 1: signature", () => {
  it("rejects a request without the x-razorpay-signature header", async () => {
    const body = JSON.stringify(chargedPayload());
    const req = new NextRequest("https://example.com/api/webhooks/razorpay", {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json" },
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(mockChargedHandler).not.toHaveBeenCalled();
  });

  it("rejects a tampered signature", async () => {
    const body = JSON.stringify(chargedPayload());
    const res = await POST(makeWebhookRequest(body, "deadbeef".repeat(8)));
    expect(res.status).toBe(400);
    expect(mockChargedHandler).not.toHaveBeenCalled();
  });

  it("rejects a signature produced with the wrong secret", async () => {
    const body = JSON.stringify(chargedPayload());
    const wrongSig = signBody(body, "different-secret");
    const res = await POST(makeWebhookRequest(body, wrongSig));
    expect(res.status).toBe(400);
    expect(mockChargedHandler).not.toHaveBeenCalled();
  });

  it("accepts a correctly-signed body", async () => {
    const body = JSON.stringify(chargedPayload());
    const res = await POST(makeWebhookRequest(body, signBody(body)));
    expect(res.status).toBe(200);
    expect(mockChargedHandler).toHaveBeenCalledTimes(1);
  });

  it("rejects body-vs-signature mismatch (attacker re-uses a sig against a different body)", async () => {
    // Sign payload A, send payload B's body with that signature.
    const bodyA = JSON.stringify(chargedPayload({ paymentId: "pay_A" }));
    const sigA = signBody(bodyA);
    const bodyB = JSON.stringify(chargedPayload({ paymentId: "pay_B" }));

    const res = await POST(makeWebhookRequest(bodyB, sigA));
    expect(res.status).toBe(400);
    expect(mockChargedHandler).not.toHaveBeenCalled();
  });
});

// ── Layer 2: timestamp ──────────────────────────────────────────────────────

describe("POST /api/webhooks/razorpay — Layer 2: stale-event rejection", () => {
  it("silently accepts but does NOT process events older than 24 h", async () => {
    // 25-hour-old event — past the 24h replay window.
    const oldTimestamp = Math.floor(Date.now() / 1000) - 25 * 60 * 60;
    const body = JSON.stringify(chargedPayload({ createdAt: oldTimestamp }));
    const res = await POST(makeWebhookRequest(body, signBody(body)));

    // Returns 200 so Razorpay stops retrying — but the dispatch handler
    // never runs. This is the documented contract.
    expect(res.status).toBe(200);
    expect(mockChargedHandler).not.toHaveBeenCalled();
  });

  it("accepts events at the boundary (23h59m old, signature valid)", async () => {
    const recentEnough = Math.floor(Date.now() / 1000) - 23 * 60 * 60;
    const body = JSON.stringify(chargedPayload({ createdAt: recentEnough }));
    const res = await POST(makeWebhookRequest(body, signBody(body)));
    expect(res.status).toBe(200);
    expect(mockChargedHandler).toHaveBeenCalledTimes(1);
  });

  it("doesn't reject when created_at is missing (older webhook deliveries)", async () => {
    // Some legacy Razorpay payloads omit created_at — defensive: process anyway.
    const noTs = { ...chargedPayload(), created_at: undefined };
    const body = JSON.stringify(noTs);
    const res = await POST(makeWebhookRequest(body, signBody(body)));
    expect(res.status).toBe(200);
    expect(mockChargedHandler).toHaveBeenCalledTimes(1);
  });
});

// ── Layer 3: Redis nonce dedup ──────────────────────────────────────────────

describe("POST /api/webhooks/razorpay — Layer 3: Redis nonce idempotency", () => {
  it("dispatches the handler on first delivery (Redis SET NX claims the key)", async () => {
    mockRedisSet.mockResolvedValueOnce("OK");
    const body = JSON.stringify(chargedPayload({ paymentId: "pay_dedup_test" }));
    const res = await POST(makeWebhookRequest(body, signBody(body)));
    expect(res.status).toBe(200);
    expect(mockChargedHandler).toHaveBeenCalledTimes(1);

    // Verify the nonce key shape: webhook:nonce:{event}:{paymentId}
    expect(mockRedisSet).toHaveBeenCalledWith(
      "webhook:nonce:subscription.charged:pay_dedup_test",
      "1",
      "EX",
      expect.any(Number),
      "NX"
    );
  });

  it("does NOT dispatch on duplicate delivery (Redis SET NX returns null)", async () => {
    mockRedisSet.mockResolvedValueOnce(null); // key already exists
    const body = JSON.stringify(chargedPayload({ paymentId: "pay_dup_test" }));
    const res = await POST(makeWebhookRequest(body, signBody(body)));

    expect(res.status).toBe(200); // ack so Razorpay stops retrying
    expect(mockChargedHandler).not.toHaveBeenCalled();
  });

  it("falls through to handler when Redis itself throws (DB idempotency is the backstop)", async () => {
    mockRedisSet.mockRejectedValueOnce(new Error("Redis unavailable"));
    const body = JSON.stringify(chargedPayload({ paymentId: "pay_redis_down_test" }));
    const res = await POST(makeWebhookRequest(body, signBody(body)));

    expect(res.status).toBe(200);
    // Critical: a Redis outage must NOT block legitimate webhooks — the
    // MongoDB idempotency check inside handleSubscriptionCharged is the
    // ultimate backstop.
    expect(mockChargedHandler).toHaveBeenCalledTimes(1);
  });
});

// ── Event dispatch table ────────────────────────────────────────────────────

describe("POST /api/webhooks/razorpay — event dispatch", () => {
  it("routes 'subscription.charged' to handleSubscriptionCharged", async () => {
    const body = JSON.stringify(chargedPayload());
    const res = await POST(makeWebhookRequest(body, signBody(body)));
    expect(res.status).toBe(200);
    expect(mockChargedHandler).toHaveBeenCalledTimes(1);
    expect(mockFailedHandler).not.toHaveBeenCalled();
  });

  it("routes 'subscription.payment_failed' to handleSubscriptionFailed", async () => {
    const body = JSON.stringify(failedPayload());
    const res = await POST(makeWebhookRequest(body, signBody(body)));
    expect(res.status).toBe(200);
    expect(mockFailedHandler).toHaveBeenCalledTimes(1);
    expect(mockChargedHandler).not.toHaveBeenCalled();
  });

  it("acknowledges unknown event types with 200 + no handler call", async () => {
    // Razorpay publishes many events the app doesn't care about
    // (order.paid, payment.failed, etc.). Acking them keeps Razorpay
    // from retrying; ignoring them means we don't accidentally double-act.
    const otherEvent = {
      event: "order.paid",
      created_at: Math.floor(Date.now() / 1000),
      payload: { payment: { entity: { id: "pay_x_other" } } },
    };
    const body = JSON.stringify(otherEvent);
    const res = await POST(makeWebhookRequest(body, signBody(body)));

    expect(res.status).toBe(200);
    expect(mockChargedHandler).not.toHaveBeenCalled();
    expect(mockFailedHandler).not.toHaveBeenCalled();
  });
});

// ── Layer 5: error masking ──────────────────────────────────────────────────

describe("POST /api/webhooks/razorpay — Layer 5: error masking", () => {
  it("returns a generic 500 + WEBHOOK_ERROR code when the handler throws", async () => {
    // Inner-error path is harder to hit deliberately, but the easiest is to
    // make the dispatch handler throw — the route's outer catch turns it
    // into the masked error response.
    mockChargedHandler.mockRejectedValueOnce(new Error("Internal DB error with credentials"));
    const body = JSON.stringify(chargedPayload());
    const res = await POST(makeWebhookRequest(body, signBody(body)));

    expect(res.status).toBe(500);
    const json = await res.json();
    // Critical: don't leak the internal exception message back to Razorpay
    // (or anyone replaying the webhook URL). The route uses a generic
    // message so internals stay private.
    expect(json.error).toBe("Webhook processing failed");
    expect(json.code).toBe("WEBHOOK_ERROR");
    // The internal error message ("Internal DB error with credentials")
    // must not appear in the response body.
    expect(JSON.stringify(json)).not.toContain("credentials");
  });
});
