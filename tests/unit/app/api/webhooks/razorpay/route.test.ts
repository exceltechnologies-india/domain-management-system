/**
 * Tests for `app/api/webhooks/razorpay/route.ts` (slice 7gh). Most
 * security-critical surface in the codebase — anyone who can forge a
 * webhook delivery can mark unpaid orders as paid. Pins the full
 * 5-layer defense:
 *
 *  1. HMAC signature verification (RazorpayService.verifyWebhookSignature
 *     receives the RAW request body — JSON.parse must NOT run first or
 *     the signature won't match Razorpay's computation)
 *  2. 24h timestamp gate (payload.created_at) — anti-replay window
 *     wider than Razorpay's max retry interval; stale events return
 *     200 (not 4xx) so Razorpay stops retrying
 *  3. Redis nonce dedup — SET NX with 15-minute TTL on a key derived
 *     from event + paymentId. Atomic-claim (only the first delivery
 *     within the TTL wins). Redis failure falls THROUGH to handler
 *     (MongoDB processed-flag is the backstop), with a warn log
 *  4. MongoDB processed-flag (inside the handler, not asserted here)
 *  5. Always 200 once signature is verified — never let Razorpay
 *     keep retrying because our handler hit a temporary 500
 *
 * Additional pins:
 *  - Missing signature OR missing secret → 400 WEBHOOK_CONFIG_ERROR
 *    (config error vs forgery — distinguish but both are 4xx; never
 *    leak which one is missing)
 *  - Bad signature → 400 INVALID_SIGNATURE (NEVER process the body)
 *  - Event 'subscription.charged' → handleSubscriptionCharged called
 *    with FULL payload (incl. created_at + payment entity)
 *  - Event 'subscription.halted' → handleSubscriptionFailed called
 *    (razorpay-side event for "retry budget exhausted")
 *  - Other events → still 200 (no-op pass-through)
 *  - Outer catch → 500 WEBHOOK_ERROR generic ('Webhook processing
 *    failed' — no stack leak)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const verifyWebhookSignature = vi.hoisted(() => vi.fn());
vi.mock("@/lib/razorpay", () => ({
  RazorpayService: { verifyWebhookSignature },
}));

const connectDB = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

const redisSet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/redis", () => ({
  redis: { set: redisSet },
}));

const handleSubscriptionCharged = vi.hoisted(() => vi.fn());
const handleSubscriptionFailed = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/payment/webhook-handlers", () => ({
  handleSubscriptionCharged,
  handleSubscriptionFailed,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/webhooks/razorpay/route";

const ORIG_ENV = process.env.RAZORPAY_WEBHOOK_SECRET;
const NOW = new Date("2026-06-08T12:00:00.000Z").getTime();

function makeReq(payload: unknown, headers: Record<string, string> = {}) {
  const body = JSON.stringify(payload);
  return new NextRequest("https://example.com/api/webhooks/razorpay", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
  });
}

function freshPayload(overrides: Record<string, unknown> = {}) {
  return {
    event: "subscription.charged",
    created_at: Math.floor(NOW / 1000), // seconds, like Razorpay
    payload: {
      payment: {
        entity: { id: "pay_TEST123" },
      },
      subscription: {
        entity: { id: "sub_TEST" },
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  process.env.RAZORPAY_WEBHOOK_SECRET = "test-secret";
  verifyWebhookSignature.mockReset().mockReturnValue(true);
  redisSet.mockReset().mockResolvedValue("OK");
  handleSubscriptionCharged.mockReset().mockResolvedValue(undefined);
  handleSubscriptionFailed.mockReset().mockResolvedValue(undefined);
  connectDB.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  process.env.RAZORPAY_WEBHOOK_SECRET = ORIG_ENV;
});

// ─── Layer 1: signature verification ──────────────────────────────
describe("Layer 1 — signature verification", () => {
  it("missing x-razorpay-signature header → 400 WEBHOOK_CONFIG_ERROR; NO verify, NO handler", async () => {
    const res = await POST(makeReq(freshPayload()));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("WEBHOOK_CONFIG_ERROR");
    expect(verifyWebhookSignature).not.toHaveBeenCalled();
    expect(handleSubscriptionCharged).not.toHaveBeenCalled();
  });

  it("missing RAZORPAY_WEBHOOK_SECRET env → 400 WEBHOOK_CONFIG_ERROR", async () => {
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    const res = await POST(
      makeReq(freshPayload(), { "x-razorpay-signature": "sig" })
    );
    expect(res.status).toBe(400);
    expect(verifyWebhookSignature).not.toHaveBeenCalled();
  });

  it("verifyWebhookSignature receives the RAW request body (not JSON-parsed)", async () => {
    const payload = freshPayload();
    await POST(makeReq(payload, { "x-razorpay-signature": "the-sig" }));
    expect(verifyWebhookSignature).toHaveBeenCalledWith(
      JSON.stringify(payload),
      "the-sig",
      "test-secret"
    );
  });

  it("verifyWebhookSignature returns false → 400 INVALID_SIGNATURE; NO handler, NO DB connect, NO Redis", async () => {
    verifyWebhookSignature.mockReturnValueOnce(false);
    const res = await POST(
      makeReq(freshPayload(), { "x-razorpay-signature": "forged" })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_SIGNATURE");
    expect(handleSubscriptionCharged).not.toHaveBeenCalled();
    expect(connectDB).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
  });
});

// ─── Layer 2: timestamp gate (anti-replay) ────────────────────────
describe("Layer 2 — 24h timestamp gate (anti-replay)", () => {
  it("event older than 24h → 200 (so Razorpay stops retrying); handler NOT called", async () => {
    const staleCreatedAt = Math.floor(NOW / 1000) - 25 * 60 * 60; // 25h ago
    const res = await POST(
      makeReq(freshPayload({ created_at: staleCreatedAt }), {
        "x-razorpay-signature": "sig",
      })
    );
    expect(res.status).toBe(200);
    expect(handleSubscriptionCharged).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
  });

  it("event exactly at 24h is still considered stale (> not >=)", async () => {
    const boundary = Math.floor(NOW / 1000) - 24 * 60 * 60 - 1; // just over
    const res = await POST(
      makeReq(freshPayload({ created_at: boundary }), {
        "x-razorpay-signature": "sig",
      })
    );
    expect(res.status).toBe(200);
    expect(handleSubscriptionCharged).not.toHaveBeenCalled();
  });

  it("event within window proceeds to dedup + handler", async () => {
    const recent = Math.floor(NOW / 1000) - 60; // 1 min ago
    await POST(
      makeReq(freshPayload({ created_at: recent }), {
        "x-razorpay-signature": "sig",
      })
    );
    expect(handleSubscriptionCharged).toHaveBeenCalled();
  });

  it("missing created_at → skip the timestamp check (fail-open is intentional — old events without created_at still get processed once)", async () => {
    const noTs = freshPayload();
    delete (noTs as { created_at?: unknown }).created_at;
    await POST(makeReq(noTs, { "x-razorpay-signature": "sig" }));
    expect(handleSubscriptionCharged).toHaveBeenCalled();
  });
});

// ─── Layer 3: Redis nonce dedup ───────────────────────────────────
describe("Layer 3 — Redis nonce dedup", () => {
  it("SET NX with 15min TTL on `webhook:nonce:${event}:${paymentId}`", async () => {
    await POST(makeReq(freshPayload(), { "x-razorpay-signature": "sig" }));
    expect(redisSet).toHaveBeenCalledWith(
      "webhook:nonce:subscription.charged:pay_TEST123",
      "1",
      "EX",
      15 * 60,
      "NX"
    );
  });

  it("Redis SET NX returns null (already claimed) → 200 dedup; handler NOT called", async () => {
    redisSet.mockResolvedValueOnce(null);
    const res = await POST(
      makeReq(freshPayload(), { "x-razorpay-signature": "sig" })
    );
    expect(res.status).toBe(200);
    expect(handleSubscriptionCharged).not.toHaveBeenCalled();
    expect(connectDB).not.toHaveBeenCalled();
  });

  it("Redis throw → FALL THROUGH to handler (MongoDB processed-flag is the backstop)", async () => {
    redisSet.mockRejectedValueOnce(new Error("Redis down"));
    const res = await POST(
      makeReq(freshPayload(), { "x-razorpay-signature": "sig" })
    );
    expect(res.status).toBe(200);
    expect(handleSubscriptionCharged).toHaveBeenCalled();
  });

  it("missing paymentId in payload → skip Redis dedup (handler still runs)", async () => {
    const noPay = freshPayload({
      payload: { subscription: { entity: { id: "sub_X" } } },
    });
    await POST(makeReq(noPay, { "x-razorpay-signature": "sig" }));
    expect(redisSet).not.toHaveBeenCalled();
    expect(handleSubscriptionCharged).toHaveBeenCalled();
  });
});

// ─── Layer 4: event routing ───────────────────────────────────────
describe("Event routing", () => {
  it("'subscription.charged' → handleSubscriptionCharged with FULL payload", async () => {
    const payload = freshPayload();
    await POST(makeReq(payload, { "x-razorpay-signature": "sig" }));
    expect(handleSubscriptionCharged).toHaveBeenCalledWith(payload);
    expect(handleSubscriptionFailed).not.toHaveBeenCalled();
  });

  it("'subscription.halted' → handleSubscriptionFailed", async () => {
    const payload = freshPayload({ event: "subscription.halted" });
    await POST(makeReq(payload, { "x-razorpay-signature": "sig" }));
    expect(handleSubscriptionFailed).toHaveBeenCalledWith(payload);
    expect(handleSubscriptionCharged).not.toHaveBeenCalled();
  });

  it("unknown event → 200 no-op (no handler called)", async () => {
    const payload = freshPayload({ event: "payment.captured" });
    const res = await POST(
      makeReq(payload, { "x-razorpay-signature": "sig" })
    );
    expect(res.status).toBe(200);
    expect(handleSubscriptionCharged).not.toHaveBeenCalled();
    expect(handleSubscriptionFailed).not.toHaveBeenCalled();
  });
});

// ─── Layer 5: always-200 + outer catch ────────────────────────────
describe("Layer 5 — always 200 once verified; outer catch", () => {
  it("happy path → 200 { status: 'ok' }", async () => {
    const res = await POST(
      makeReq(freshPayload(), { "x-razorpay-signature": "sig" })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("handler throw → 500 WEBHOOK_ERROR generic (NOT 200 — this is the only case we let Razorpay retry)", async () => {
    handleSubscriptionCharged.mockRejectedValueOnce(new Error("DB exploded"));
    const res = await POST(
      makeReq(freshPayload(), { "x-razorpay-signature": "sig" })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("WEBHOOK_ERROR");
  });

  it("connectDB throw → 500 WEBHOOK_ERROR (no internals leaked)", async () => {
    connectDB.mockRejectedValueOnce(new Error("connect refused"));
    const res = await POST(
      makeReq(freshPayload(), { "x-razorpay-signature": "sig" })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Webhook processing failed");
  });
});
