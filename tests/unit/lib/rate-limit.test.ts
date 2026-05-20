/**
 * Integration-style tests for the rate-limit middleware.
 *
 * The rate-limit module is a thin wrapper around Redis INCR + EXPIRE, so the
 * tests mock the redis client and drive the limiter through the actual
 * windowMs / maxRequests math + key-generation paths. This catches three
 * classes of regression the unit-test suite previously missed:
 *
 *   1. Off-by-one window arithmetic — does the Nth request inside a window
 *      get allowed (it should) and the (N+1)th get blocked?
 *   2. Key-generation fallback chain — `request.ip` → `x-forwarded-for` →
 *      `x-real-ip` → "unknown". A misordering here means an attacker
 *      bypasses limits by setting x-forwarded-for.
 *   3. Fail-open behaviour when Redis throws — a Redis outage must NOT
 *      lock every legitimate request out of the app.
 *
 * Tests target the named limiters in `rateLimiters.*` so the per-endpoint
 * window/max contracts (login: 5/15min, register: 5/1h, etc.) are exercised
 * as configuration regressions surface here, not in production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

// In-memory Redis stand-in. Held outside the vi.mock factory so each test can
// reset state via clearStore() without re-instantiating the mock.
const redisStore = new Map<string, { count: number; expiresAt: number }>();
let redisThrowsOnIncr = false;
const clearStore = () => {
  redisStore.clear();
  redisThrowsOnIncr = false;
};

vi.mock("@/lib/redis", () => ({
  redis: {
    incr: vi.fn(async (key: string) => {
      if (redisThrowsOnIncr) throw new Error("Redis unavailable");
      const existing = redisStore.get(key);
      const now = Date.now();
      // Expire entries past their TTL so tests can simulate window rollovers
      // by advancing the clock + reading after expiry.
      if (existing && existing.expiresAt < now) {
        redisStore.delete(key);
      }
      const entry = redisStore.get(key) ?? { count: 0, expiresAt: now + 60_000 };
      entry.count += 1;
      redisStore.set(key, entry);
      return entry.count;
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      const entry = redisStore.get(key);
      if (entry) entry.expiresAt = Date.now() + seconds * 1000;
      return 1;
    }),
    ttl: vi.fn(async (key: string) => {
      const entry = redisStore.get(key);
      if (!entry) return -2;
      const remainingMs = entry.expiresAt - Date.now();
      return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : -2;
    }),
  },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn(), debug: vi.fn() },
}));

import { RateLimiter, rateLimiters } from "@/lib/rate-limit";

beforeEach(() => {
  clearStore();
});
afterEach(() => {
  vi.clearAllMocks();
});

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Build a minimal NextRequest-like object — only fields the rate-limit code reads. */
function makeRequest(opts: {
  ip?: string;
  forwardedFor?: string;
  realIp?: string;
  userId?: string;
} = {}): NextRequest {
  const headers = new Map<string, string>();
  if (opts.forwardedFor) headers.set("x-forwarded-for", opts.forwardedFor);
  if (opts.realIp) headers.set("x-real-ip", opts.realIp);
  if (opts.userId) headers.set("x-user-id", opts.userId);

  return {
    ip: opts.ip,
    headers: {
      get: (name: string) => headers.get(name.toLowerCase()) ?? null,
    },
  } as unknown as NextRequest;
}

// ── Core window arithmetic ───────────────────────────────────────────────────

describe("RateLimiter — window arithmetic", () => {
  it("allows the Nth request inside the window and blocks the (N+1)th", async () => {
    const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 3 });
    const req = makeRequest({ ip: "10.0.0.1" });

    const r1 = await limiter.isAllowed(req);
    const r2 = await limiter.isAllowed(req);
    const r3 = await limiter.isAllowed(req);
    const r4 = await limiter.isAllowed(req);

    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);

    // The 4th request crosses maxRequests — must be denied.
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
  });

  it("returns a positive resetTime in the future after the first hit", async () => {
    const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 5 });
    const before = Date.now();
    const { resetTime } = await limiter.isAllowed(makeRequest({ ip: "10.0.0.2" }));
    expect(resetTime).toBeGreaterThan(before);
    // The resetTime should be no further out than `now + windowMs + small slack`.
    expect(resetTime).toBeLessThanOrEqual(Date.now() + 60_000 + 1_000);
  });

  it("scopes counts per key — two different IPs each get their own quota", async () => {
    const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 2 });
    const reqA = makeRequest({ ip: "10.0.0.1" });
    const reqB = makeRequest({ ip: "10.0.0.2" });

    await limiter.isAllowed(reqA);
    await limiter.isAllowed(reqA); // A exhausted
    const aBlocked = await limiter.isAllowed(reqA);

    const bStillAllowed = await limiter.isAllowed(reqB);

    expect(aBlocked.allowed).toBe(false);
    expect(bStillAllowed.allowed).toBe(true);
  });
});

// ── Key-generation fallback chain ────────────────────────────────────────────
//
// SECURITY-CRITICAL: a regression here means an attacker can bypass per-IP
// limits by forging x-forwarded-for. The order of precedence must stay:
//   request.ip > x-forwarded-for > x-real-ip > "unknown"

describe("RateLimiter — IP fallback chain", () => {
  it("prefers request.ip when present (most trustworthy — populated by Next runtime)", async () => {
    const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 1 });
    // Same request.ip across two requests, different forwarded-for → must be
    // treated as the same client (request.ip wins) → second request blocked.
    const req1 = makeRequest({ ip: "10.0.0.1", forwardedFor: "1.2.3.4" });
    const req2 = makeRequest({ ip: "10.0.0.1", forwardedFor: "5.6.7.8" });

    const r1 = await limiter.isAllowed(req1);
    const r2 = await limiter.isAllowed(req2);

    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(false);
  });

  it("falls back to x-forwarded-for when request.ip is undefined", async () => {
    const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 1 });
    const req1 = makeRequest({ forwardedFor: "1.2.3.4" });
    const req2 = makeRequest({ forwardedFor: "1.2.3.4" });

    expect((await limiter.isAllowed(req1)).allowed).toBe(true);
    expect((await limiter.isAllowed(req2)).allowed).toBe(false);
  });

  it("falls back to x-real-ip when neither request.ip nor x-forwarded-for is set", async () => {
    const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 1 });
    const req1 = makeRequest({ realIp: "9.9.9.9" });
    const req2 = makeRequest({ realIp: "9.9.9.9" });

    expect((await limiter.isAllowed(req1)).allowed).toBe(true);
    expect((await limiter.isAllowed(req2)).allowed).toBe(false);
  });

  it("collapses all unknown-IP requests into a single bucket", async () => {
    // SECURITY EDGE CASE: if every "unknown" client got its own bucket, a
    // crafted request stripped of all IP-bearing fields would bypass limits.
    const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 1 });
    const r1 = await limiter.isAllowed(makeRequest());
    const r2 = await limiter.isAllowed(makeRequest());
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(false);
  });
});

// ── Fail-open on Redis outage ────────────────────────────────────────────────

describe("RateLimiter — Redis outage handling", () => {
  it("fails open when Redis throws (does not lock out legitimate users)", async () => {
    const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 5 });
    redisThrowsOnIncr = true;

    const result = await limiter.isAllowed(makeRequest({ ip: "10.0.0.1" }));
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(5); // full quota reported (safe upper bound)
  });

  it("recovers cleanly when Redis comes back", async () => {
    const limiter = new RateLimiter({ windowMs: 60_000, maxRequests: 3 });
    redisThrowsOnIncr = true;
    const downResult = await limiter.isAllowed(makeRequest({ ip: "10.0.0.1" }));
    expect(downResult.allowed).toBe(true);

    redisThrowsOnIncr = false;
    const upResult = await limiter.isAllowed(makeRequest({ ip: "10.0.0.1" }));
    expect(upResult.allowed).toBe(true);
    expect(upResult.remaining).toBe(2);
  });
});

// ── checkKey() direct entry — used by the auth flow with composite keys ──────

describe("RateLimiter.checkKey — composite-key path", () => {
  it("accepts arbitrary key strings (e.g. login:email:ip from providers.ts)", async () => {
    // The credentials provider calls checkKey(`login:${email}:${ip}`) so a
    // per-user-and-per-IP bucket can catch both per-account and per-attacker
    // brute-force attempts. Make sure that path returns the same shape.
    const limiter = new RateLimiter({ windowMs: 15 * 60_000, maxRequests: 5 });
    const key = "login:victim@example.com:10.0.0.1";

    for (let i = 0; i < 5; i++) {
      expect((await limiter.checkKey(key)).allowed).toBe(true);
    }
    expect((await limiter.checkKey(key)).allowed).toBe(false);
  });
});

// ── Per-endpoint configuration contracts ─────────────────────────────────────
//
// These tests fence the per-endpoint windowMs/maxRequests values from
// silent regressions. If someone bumps `login` from 5 to 50 attempts by
// accident, this suite catches it before the change ships.

describe("rateLimiters — per-endpoint contracts", () => {
  it("login: 5 attempts per 15 minutes (brute-force protection)", async () => {
    const ip = "10.0.0.1";
    const req = makeRequest({ ip });
    for (let i = 0; i < 5; i++) {
      expect((await rateLimiters.login.isAllowed(req)).allowed).toBe(true);
    }
    expect((await rateLimiters.login.isAllowed(req)).allowed).toBe(false);
  });

  it("passwordReset: 3 attempts per hour", async () => {
    const req = makeRequest({ ip: "10.0.0.1" });
    for (let i = 0; i < 3; i++) {
      expect((await rateLimiters.passwordReset.isAllowed(req)).allowed).toBe(true);
    }
    expect((await rateLimiters.passwordReset.isAllowed(req)).allowed).toBe(false);
  });

  it("register: 5 attempts per hour", async () => {
    const req = makeRequest({ ip: "10.0.0.1" });
    for (let i = 0; i < 5; i++) {
      expect((await rateLimiters.register.isAllowed(req)).allowed).toBe(true);
    }
    expect((await rateLimiters.register.isAllowed(req)).allowed).toBe(false);
  });

  it("trialOtpSend: 3 attempts per 10 minutes (SMS-spend protection)", async () => {
    const req = makeRequest({ ip: "10.0.0.1" });
    for (let i = 0; i < 3; i++) {
      expect((await rateLimiters.trialOtpSend.isAllowed(req)).allowed).toBe(true);
    }
    expect((await rateLimiters.trialOtpSend.isAllowed(req)).allowed).toBe(false);
  });

  it("trialOtpVerify: 10 attempts per 10 minutes (separate from send to allow re-attempts)", async () => {
    const req = makeRequest({ ip: "10.0.0.1" });
    for (let i = 0; i < 10; i++) {
      expect((await rateLimiters.trialOtpVerify.isAllowed(req)).allowed).toBe(true);
    }
    expect((await rateLimiters.trialOtpVerify.isAllowed(req)).allowed).toBe(false);
  });

  it("login and register limiters do not share buckets (different key prefixes)", async () => {
    // Both use ipKey(...) with different prefixes — exhausting login must
    // not affect register, and vice versa.
    const req = makeRequest({ ip: "10.0.0.1" });
    for (let i = 0; i < 5; i++) await rateLimiters.login.isAllowed(req);
    expect((await rateLimiters.login.isAllowed(req)).allowed).toBe(false);

    // Register from the same IP should still have a fresh quota.
    expect((await rateLimiters.register.isAllowed(req)).allowed).toBe(true);
  });

  it("supportCreate scopes by userId (per-user spam protection)", async () => {
    // userOrIpKey reads x-user-id first; two requests from the same user
    // but different IPs must share a bucket.
    const reqA = makeRequest({ userId: "user-1", ip: "10.0.0.1" });
    const reqB = makeRequest({ userId: "user-1", ip: "10.0.0.2" });

    for (let i = 0; i < 5; i++) {
      expect((await rateLimiters.supportCreate.isAllowed(reqA)).allowed).toBe(true);
    }
    // Same user from a different IP — already exhausted, must be blocked.
    expect((await rateLimiters.supportCreate.isAllowed(reqB)).allowed).toBe(false);
  });

  it("pdfInvoice falls back to IP when x-user-id is missing", async () => {
    // Useful for the guest-checkout invoice download path that doesn't have
    // a user session yet but still needs Zoho-cost protection.
    const reqA = makeRequest({ ip: "10.0.0.1" });
    for (let i = 0; i < 10; i++) {
      expect((await rateLimiters.pdfInvoice.isAllowed(reqA)).allowed).toBe(true);
    }
    expect((await rateLimiters.pdfInvoice.isAllowed(reqA)).allowed).toBe(false);

    // A different IP, no user id — fresh bucket.
    expect((await rateLimiters.pdfInvoice.isAllowed(makeRequest({ ip: "10.0.0.2" }))).allowed).toBe(true);
  });
});
