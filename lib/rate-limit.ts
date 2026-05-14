import { NextRequest } from "next/server";
import { redis } from "@/lib/redis";
import { serverLogger } from "@/lib/server-logger";

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyGenerator?: (request: NextRequest) => string;
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
    const ip =
      (request as any).ip ||
      request.headers.get("x-forwarded-for") ||
      request.headers.get("x-real-ip") ||
      "unknown";
    return `rate_limit:${ip}`;
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
    keyGenerator: (request) => {
      const ip =
        (request as any).ip ||
        request.headers.get("x-forwarded-for") ||
        request.headers.get("x-real-ip") ||
        "unknown";
      return `login:${ip}`;
    },
  }),

  passwordReset: new RateLimiter({
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: 3,
    keyGenerator: (request) => {
      const ip =
        (request as any).ip ||
        request.headers.get("x-forwarded-for") ||
        request.headers.get("x-real-ip") ||
        "unknown";
      return `password_reset:${ip}`;
    },
  }),

  trialOtpSend: new RateLimiter({
    windowMs: 10 * 60 * 1000, // 10 minutes
    maxRequests: 3,
    keyGenerator: (request) => {
      const ip =
        (request as any).ip ||
        request.headers.get("x-forwarded-for") ||
        request.headers.get("x-real-ip") ||
        "unknown";
      return `trial_otp_send:${ip}`;
    },
  }),

  trialOtpVerify: new RateLimiter({
    windowMs: 10 * 60 * 1000, // 10 minutes
    maxRequests: 10,
    keyGenerator: (request) => {
      const ip =
        (request as any).ip ||
        request.headers.get("x-forwarded-for") ||
        request.headers.get("x-real-ip") ||
        "unknown";
      return `trial_otp_verify:${ip}`;
    },
  }),

  admin: new RateLimiter({
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 30,
  }),

  register: new RateLimiter({
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: 5,
    keyGenerator: (request) => {
      const ip =
        (request as any).ip ||
        request.headers.get("x-forwarded-for") ||
        request.headers.get("x-real-ip") ||
        "unknown";
      return `register:${ip}`;
    },
  }),

  activation: new RateLimiter({
    windowMs: 15 * 60 * 1000, // 15 minutes
    maxRequests: 10,
    keyGenerator: (request) => {
      const ip =
        (request as any).ip ||
        request.headers.get("x-forwarded-for") ||
        request.headers.get("x-real-ip") ||
        "unknown";
      return `activation:${ip}`;
    },
  }),

  resendActivation: new RateLimiter({
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: 3,
    keyGenerator: (request) => {
      const ip =
        (request as any).ip ||
        request.headers.get("x-forwarded-for") ||
        request.headers.get("x-real-ip") ||
        "unknown";
      return `resend_activation:${ip}`;
    },
  }),

  domainSearch: new RateLimiter({
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 20,
    keyGenerator: (request) => {
      const ip =
        (request as any).ip ||
        request.headers.get("x-forwarded-for") ||
        request.headers.get("x-real-ip") ||
        "unknown";
      return `domain_search:${ip}`;
    },
  }),

  domainPricing: new RateLimiter({
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 30,
    keyGenerator: (request) => {
      const ip =
        (request as any).ip ||
        request.headers.get("x-forwarded-for") ||
        request.headers.get("x-real-ip") ||
        "unknown";
      return `domain_pricing:${ip}`;
    },
  }),

  bulkDomainSearch: new RateLimiter({
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 5,
    keyGenerator: (request) => {
      const ip =
        (request as any).ip ||
        request.headers.get("x-forwarded-for") ||
        request.headers.get("x-real-ip") ||
        "unknown";
      return `bulk_domain_search:${ip}`;
    },
  }),

  // Support ticket creation — limit per-user to discourage spam ticket creation
  supportCreate: new RateLimiter({
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: 5,
    keyGenerator: (request) => {
      const userId =
        request.headers.get("x-user-id") ||
        (request as any).ip ||
        request.headers.get("x-forwarded-for") ||
        "unknown";
      return `support_create:${userId}`;
    },
  }),

  // Support ticket replies — more permissive (legitimate back-and-forth)
  supportReply: new RateLimiter({
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: 30,
    keyGenerator: (request) => {
      const userId =
        request.headers.get("x-user-id") ||
        (request as any).ip ||
        request.headers.get("x-forwarded-for") ||
        "unknown";
      return `support_reply:${userId}`;
    },
  }),

  // PDF invoice downloads: 10 per minute per user (Zoho Books API is expensive)
  pdfInvoice: new RateLimiter({
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 10,
    keyGenerator: (request) => {
      // Key by x-user-id header set by the auth layer, fall back to IP
      const userId =
        request.headers.get("x-user-id") ||
        (request as any).ip ||
        request.headers.get("x-forwarded-for") ||
        "unknown";
      return `pdf_invoice:${userId}`;
    },
  }),
};
