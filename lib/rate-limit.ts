import { NextRequest, NextResponse } from "next/server";
import { redis } from "@/lib/redis";
import { serverLogger } from "@/lib/server-logger";
import { addSecurityHeaders } from "@/lib/security-headers";

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyGenerator?: (request: NextRequest) => string;
}

/**
 * NextRequest carried `.ip` in older Next versions and dropped it in newer
 * ones. We read it via a structural type so both shapes type-check, and
 * fall through to the forwarded-for / real-ip headers if it's missing.
 */
function getClientIP(request: NextRequest): string {
  const direct = (request as unknown as { ip?: string }).ip;
  return (
    direct ||
    request.headers.get("x-forwarded-for") ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

function ipKey(prefix: string): (request: NextRequest) => string {
  return (request) => `${prefix}:${getClientIP(request)}`;
}

// Prefer an `x-user-id` header set by upstream auth middleware (so two users
// behind a NAT each get their own bucket), fall back to the client IP. Note:
// no middleware in this codebase currently emits `x-user-id`, so this
// effectively IP-keys today — that's a safe degradation. Callers that need
// genuine per-user limiting use `limiter.checkKey('prefix:' + user._id)`
// explicitly (see `app/api/user/hosting/{renew,upgrade}/route.ts`).
function userOrIpKey(prefix: string): (request: NextRequest) => string {
  return (request) => {
    const userId =
      request.headers.get("x-user-id") ||
      getClientIP(request);
    return `${prefix}:${userId}`;
  };
}

export class RateLimiter {
  private config: RateLimitConfig;

  constructor(config: RateLimitConfig) {
    this.config = config;
  }

  async isAllowed(request: NextRequest): Promise<{
    allowed: boolean;
    remaining: number;
    resetTime: number;
  }> {
    const key = this.config.keyGenerator
      ? this.config.keyGenerator(request)
      : this.getDefaultKey(request);
    return this.checkKey(key);
  }

  async checkKey(key: string): Promise<{
    allowed: boolean;
    remaining: number;
    resetTime: number;
  }> {
    const windowSeconds = Math.ceil(this.config.windowMs / 1000);

    // No Redis configured (dev / cold-start) — fail-open. Matches the
    // catch-block behaviour below so rate-limit failures don't take down
    // the app under a Redis outage.
    if (!redis) {
      return {
        allowed: true,
        remaining: this.config.maxRequests,
        resetTime: Date.now() + this.config.windowMs,
      };
    }

    try {
      const count = await redis.incr(key);
      if (count === 1) {
        // First hit in this window — set the expiry
        await redis.expire(key, windowSeconds);
      }
      const ttl = await redis.ttl(key);
      const resetTime = Date.now() + (ttl > 0 ? ttl * 1000 : this.config.windowMs);
      const allowed = count <= this.config.maxRequests;
      const remaining = Math.max(0, this.config.maxRequests - count);

      return { allowed, remaining, resetTime };
    } catch (error) {
      // Redis unavailable — fail open so a Redis outage doesn't take down the app
      serverLogger.error(`[rate-limit] Redis error for key "${key}":`, error);
      return {
        allowed: true,
        remaining: this.config.maxRequests,
        resetTime: Date.now() + this.config.windowMs,
      };
    }
  }

  private getDefaultKey(request: NextRequest): string {
    return `rate_limit:${getClientIP(request)}`;
  }
}

// Pre-configured rate limiters
export const rateLimiters = {
  api: new RateLimiter({
    windowMs: 15 * 60 * 1000, // 15 minutes
    maxRequests: 100,
  }),

  login: new RateLimiter({
    windowMs: 15 * 60 * 1000, // 15 minutes
    maxRequests: 5,
    keyGenerator: ipKey("login"),
  }),

  passwordReset: new RateLimiter({
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: 3,
    keyGenerator: ipKey("password_reset"),
  }),

  trialOtpSend: new RateLimiter({
    windowMs: 10 * 60 * 1000, // 10 minutes
    maxRequests: 3,
    keyGenerator: ipKey("trial_otp_send"),
  }),

  trialOtpVerify: new RateLimiter({
    windowMs: 10 * 60 * 1000, // 10 minutes
    maxRequests: 10,
    keyGenerator: ipKey("trial_otp_verify"),
  }),

  admin: new RateLimiter({
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 30,
  }),

  register: new RateLimiter({
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: 5,
    keyGenerator: ipKey("register"),
  }),

  activation: new RateLimiter({
    windowMs: 15 * 60 * 1000, // 15 minutes
    maxRequests: 10,
    keyGenerator: ipKey("activation"),
  }),

  resendActivation: new RateLimiter({
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: 3,
    keyGenerator: ipKey("resend_activation"),
  }),

  domainSearch: new RateLimiter({
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 20,
    keyGenerator: ipKey("domain_search"),
  }),

  domainPricing: new RateLimiter({
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 30,
    keyGenerator: ipKey("domain_pricing"),
  }),

  bulkDomainSearch: new RateLimiter({
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 5,
    keyGenerator: ipKey("bulk_domain_search"),
  }),

  // Support ticket creation — limit per-user to discourage spam ticket creation
  supportCreate: new RateLimiter({
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: 5,
    keyGenerator: userOrIpKey("support_create"),
  }),

  // Support ticket replies — more permissive (legitimate back-and-forth)
  supportReply: new RateLimiter({
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: 30,
    keyGenerator: userOrIpKey("support_reply"),
  }),

  // PDF invoice downloads: 10 per minute per user (Zoho Books API is expensive)
  pdfInvoice: new RateLimiter({
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 10,
    // Key by x-user-id header set by the auth layer, fall back to IP
    keyGenerator: userOrIpKey("pdf_invoice"),
  }),

  // Chat / Claude streaming endpoint. The endpoint is intentionally
  // available to anonymous visitors (pre-sales help), so we key by IP.
  // Cap = 10 requests/min/IP × 1024 max_tokens/request × 60 × 24
  //     = ~14.7M tokens/day/IP, the upper bound a single abuser could spend.
  chat: new RateLimiter({
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 10,
    keyGenerator: ipKey("chat"),
  }),

  // Guest checkout (unauthenticated /payments/guest/{create-order,verify}).
  // Each request hits Razorpay create-order or payment-fetch + writes a
  // user row + a pending Order. 5 attempts/min/IP is enough for a real
  // human juggling cart UI but caps abusers from minting Razorpay orders
  // at scale.
  guestCheckout: new RateLimiter({
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 5,
    keyGenerator: ipKey("guest_checkout"),
  }),

  // Public analytics journey beacon (/api/analytics/track). Unauthenticated,
  // and since dms-00443 a `view_content` / `checkout_started` hit also fires a
  // Meta Conversions API send + writes a CustomerActivity row — so an
  // unbounded public endpoint could flood Mongo + Meta. Kept deliberately
  // GENEROUS: real browsing (incl. many users behind one CGNAT/office IP)
  // rarely exceeds this, and dropping an analytics beacon is low-harm
  // (fire-and-forget; a missed event, never a broken UX). The cap only stops
  // an egregious single-IP script.
  analyticsBeacon: new RateLimiter({
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 120,
    keyGenerator: ipKey("analytics_beacon"),
  }),

  // User-side hosting renew / upgrade. Authenticated, but each call mints
  // a pending Razorpay order — callers MUST use the explicit
  // `checkKey('hosting_renew:' + user._id)` form (the renew + upgrade routes
  // do). The IP-keyed fallback below is a safety net so a future bare
  // `isAllowed(req)` call doesn't accidentally produce an unbucketed limit.
  hostingRenewUpgrade: new RateLimiter({
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 5,
    keyGenerator: ipKey("hosting_renew_fallback"),
  }),
};

/**
 * Standard 429 envelope for rate-limited endpoints. Returns the uniform
 * `Retry-After` + `X-RateLimit-*` headers that the client UI keys off of,
 * with the same security-header set every other API response carries.
 *
 * Use everywhere a `rateLimiters.X.checkKey(...)` / `.isAllowed()` call
 * fails — keeps the envelope shape consistent across the API surface.
 */
export function rateLimitResponse(
  rl: { allowed: boolean; remaining: number; resetTime: number },
  options: { message?: string; limit?: number } = {}
): NextResponse {
  const retryAfter = Math.max(1, Math.ceil((rl.resetTime - Date.now()) / 1000));
  const response = NextResponse.json(
    {
      error: options.message || "Too many requests. Please wait before retrying.",
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfter),
        "X-RateLimit-Remaining": String(rl.remaining),
        ...(options.limit ? { "X-RateLimit-Limit": String(options.limit) } : {}),
      },
    }
  );
  return addSecurityHeaders(response);
}
