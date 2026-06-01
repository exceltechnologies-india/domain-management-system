/**
 * Tests for `@/lib/security/headers` (rescan-4 slice 7ec).
 * Edge-runtime-safe CORS + security headers. Pins:
 *  - addCorsHeaders SKIPS webhook routes (/api/webhooks/*) — third
 *    party servers don't send/check CORS
 *  - matching Origin echoed back; otherwise falls back to APP_ORIGIN
 *  - Allow-Methods + Allow-Headers + Allow-Credentials always set
 *  - buildPreflightResponse: 204 + Max-Age:86400 + CORS headers
 *  - addSecurityHeaders: 4 always-on headers; HSTS only in production;
 *    CSP only in production (skippable); X-Powered-By stripped if set
 *  - strictCSP omits 'unsafe-inline' + 'unsafe-eval' from script-src
 *    (the nonce-only model for API routes + static pages)
 *  - nonce → script-src includes `'nonce-XYZ'`
 *  - setHeader respects existing headers — handler-set overrides win
 */
// Unmock next/server here (global setup.ts mocks it for jsdom). We need the
// real NextResponse class for header-spec coverage on a real Headers object.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.unmock("next/server");
const { NextResponse } = await vi.importActual<typeof import("next/server")>(
  "next/server"
);
type ReqLike = {
  nextUrl: { pathname: string };
  headers: Headers;
};

import {
  addCorsHeaders,
  buildPreflightResponse,
  addSecurityHeaders,
} from "@/lib/security/headers";

function mockReq(opts: { pathname: string; origin?: string }): ReqLike {
  return {
    nextUrl: { pathname: opts.pathname },
    headers: new Headers(opts.origin ? { origin: opts.origin } : {}),
  };
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("addCorsHeaders", () => {
  it("SKIPS webhook routes (/api/webhooks/*) — no CORS headers", () => {
    const res = new NextResponse();
    const req = mockReq({ pathname: "/api/webhooks/razorpay" });
    addCorsHeaders(res, req as never);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("echoes matching origin back when it equals APP_ORIGIN", () => {
    const res = new NextResponse();
    const req = mockReq({
      pathname: "/api/orders",
      origin: "https://app.anutech.in",
    });
    addCorsHeaders(res, req as never);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.anutech.in"
    );
  });

  it("falls back to APP_ORIGIN when origin doesn't match (defence vs CSRF-via-Origin)", () => {
    const res = new NextResponse();
    const req = mockReq({
      pathname: "/api/orders",
      origin: "https://evil.example",
    });
    addCorsHeaders(res, req as never);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.anutech.in"
    );
  });

  it("sets Allow-Credentials, Allow-Methods, and Allow-Headers", () => {
    const res = new NextResponse();
    const req = mockReq({ pathname: "/api/orders" });
    addCorsHeaders(res, req as never);
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("OPTIONS");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain(
      "Content-Type"
    );
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain(
      "X-CSRF-Token"
    );
  });
});

describe("buildPreflightResponse", () => {
  it("returns a 204 response with CORS headers + Max-Age=86400", () => {
    const req = mockReq({ pathname: "/api/orders" });
    const res = buildPreflightResponse(req as never);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Max-Age")).toBe("86400");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.anutech.in"
    );
  });
});

describe("addSecurityHeaders — always-on", () => {
  it("sets X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, Referrer-Policy", () => {
    const res = new NextResponse();
    addSecurityHeaders(res);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(res.headers.get("X-XSS-Protection")).toBe("1; mode=block");
    expect(res.headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin"
    );
  });

  it("X-Powered-By is removed if set by upstream", () => {
    const res = new NextResponse();
    res.headers.set("X-Powered-By", "Express");
    addSecurityHeaders(res);
    expect(res.headers.has("X-Powered-By")).toBe(false);
  });

  it("does NOT override headers already set by the handler (handler precedence)", () => {
    const res = new NextResponse();
    res.headers.set("X-Frame-Options", "DENY");
    addSecurityHeaders(res);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY"); // not overwritten
  });
});

describe("addSecurityHeaders — production-gated headers", () => {
  it("HSTS only set when NODE_ENV=production", () => {
    const res1 = new NextResponse();
    addSecurityHeaders(res1);
    expect(res1.headers.has("Strict-Transport-Security")).toBe(false);

    vi.stubEnv("NODE_ENV", "production");
    const res2 = new NextResponse();
    addSecurityHeaders(res2);
    expect(res2.headers.get("Strict-Transport-Security")).toMatch(
      /max-age=31536000.*includeSubDomains.*preload/
    );
  });

  it("CSP only set when NODE_ENV=production", () => {
    const res1 = new NextResponse();
    addSecurityHeaders(res1);
    expect(res1.headers.has("Content-Security-Policy")).toBe(false);

    vi.stubEnv("NODE_ENV", "production");
    const res2 = new NextResponse();
    addSecurityHeaders(res2);
    expect(res2.headers.has("Content-Security-Policy")).toBe(true);
  });

  it("skipCSP:true suppresses CSP even in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = new NextResponse();
    addSecurityHeaders(res, { skipCSP: true });
    expect(res.headers.has("Content-Security-Policy")).toBe(false);
  });
});

describe("addSecurityHeaders — CSP shape", () => {
  it("default (relaxed) mode includes 'unsafe-inline' + 'unsafe-eval' in script-src", () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = new NextResponse();
    addSecurityHeaders(res);
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("'unsafe-inline'");
    expect(csp).toContain("'unsafe-eval'");
  });

  it("strictCSP:true OMITS 'unsafe-inline' + 'unsafe-eval' from script-src (nonce-only model)", () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = new NextResponse();
    addSecurityHeaders(res, { strictCSP: true });
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    // The script-src directive should not carry unsafe-inline/eval in strict mode.
    const scriptSrc = csp.split(";").find((d) => d.includes("script-src"));
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it("nonce injects `'nonce-XYZ'` into script-src", () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = new NextResponse();
    addSecurityHeaders(res, { nonce: "abc123" });
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("'nonce-abc123'");
  });

  it("CSP carries the Razorpay + reCAPTCHA + Cloudflare turnstile allow-list", () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = new NextResponse();
    addSecurityHeaders(res);
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("checkout.razorpay.com");
    expect(csp).toContain("recaptcha.net");
    expect(csp).toContain("challenges.cloudflare.com");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("object-src 'none'");
  });
});
