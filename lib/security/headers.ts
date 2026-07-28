/**
 * Security Headers
 * Pure function for adding security headers - no dependencies on Mongoose
 * Can be used in Edge Runtime (middleware)
 */

import { NextRequest, NextResponse } from "next/server";

interface SecurityHeaderOptions {
  skipCSP?: boolean;
  nonce?: string;
  /**
   * If true, omit `'unsafe-eval'` and `'unsafe-inline'` from script-src
   * (nonce-only execution model). Use this on pages that do NOT load
   * Razorpay checkout, reCAPTCHA, or any third-party JS that relies on
   * eval/new Function(). See middleware.ts for the route allowlist.
   */
  strictCSP?: boolean;
}

const APP_ORIGIN = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.anutech.in";

const CORS_ALLOW_HEADERS =
  "Content-Type, Authorization, X-CSRF-Token, X-Requested-With, x-request-id";
const CORS_ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD";

/**
 * Add CORS headers to an API response.
 *
 * Allows requests only from the app's own origin. If the incoming request
 * carries an `Origin` header that matches, we echo it back (required for
 * credentialed requests); otherwise we restrict to the canonical APP_ORIGIN.
 *
 * Webhook routes (/api/webhooks/*) are excluded — they are called
 * server-to-server where CORS checks do not apply.
 */
export function addCorsHeaders(
  response: NextResponse,
  request: NextRequest
): NextResponse {
  const pathname = request.nextUrl.pathname;
  // Webhook endpoints are called directly by third-party servers — skip CORS
  if (pathname.startsWith("/api/webhooks/")) return response;

  const requestOrigin = request.headers.get("origin") ?? "";
  const allowedOrigin =
    requestOrigin === APP_ORIGIN ? requestOrigin : APP_ORIGIN;

  response.headers.set("Access-Control-Allow-Origin", allowedOrigin);
  response.headers.set("Access-Control-Allow-Credentials", "true");
  response.headers.set("Access-Control-Allow-Methods", CORS_ALLOW_METHODS);
  response.headers.set("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
  return response;
}

/**
 * Build a preflight (OPTIONS) response with the correct CORS headers.
 * Returns a 204 No Content response — no body needed for preflight.
 */
export function buildPreflightResponse(request: NextRequest): NextResponse {
  const response = new NextResponse(null, { status: 204 });
  addCorsHeaders(response, request);
  response.headers.set("Access-Control-Max-Age", "86400");
  return response;
}

/**
 * Add security headers to response
 * This is a pure function with no external dependencies
 * It only sets headers if they aren't already present to avoid overriding handler-level overrides.
 */
export function addSecurityHeaders(
  response: NextResponse,
  options: SecurityHeaderOptions = {}
): NextResponse {
  const setHeader = (name: string, value: string) => {
    if (!response.headers.has(name)) {
      response.headers.set(name, value);
    }
  };

  // Security headers
  setHeader("X-Content-Type-Options", "nosniff");
  // Razorpay loads its checkout *inside* our page (frame-src handles that).
  // Our pages don't need to be embeddable by third parties, so SAMEORIGIN is safe.
  setHeader("X-Frame-Options", "SAMEORIGIN");
  setHeader("X-XSS-Protection", "1; mode=block");
  setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  // HSTS (only in production with HTTPS)
  if (process.env.NODE_ENV === "production") {
    setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains; preload"
    );
  }

  // Only apply CSP in production to avoid development issues
  if (process.env.NODE_ENV === "production" && !options.skipCSP) {
    // Per CSP Level 3: if a nonce is present, modern browsers ignore 'unsafe-inline'.
    // 'unsafe-inline' is kept as a fallback for CSP2-only browsers (relaxed mode only).
    // 'unsafe-eval' is required by Razorpay checkout and reCAPTCHA — kept in relaxed
    // mode only. Strict mode (API routes + static legal/marketing/error pages) uses a
    // nonce-only model so an XSS hole there can't pivot via eval/new Function() or
    // injected inline scripts.
    const nonceDirective = options.nonce ? `'nonce-${options.nonce}'` : "";
    const scriptUnsafe = options.strictCSP ? "" : "'unsafe-inline' 'unsafe-eval' ";
    // Analytics / marketing-tag provider origins. Always allowlisted (harmless
    // when no tag is configured) so the admin-managed tracking IDs render
    // without an edge→DB read in middleware. The site only ever loads
    // FIRST-PARTY nonce'd snippets keyed on validated IDs (see
    // components/TrackingScripts.tsx + lib/services/tracking.ts); these hosts
    // cover the loader scripts + the sub-resources those loaders fetch (gtag,
    // GTM containers, fbevents) and the beacon endpoints.
    const trackingScript =
      "https://www.googletagmanager.com https://www.google-analytics.com https://ssl.google-analytics.com https://connect.facebook.net https://www.googleadservices.com https://googleads.g.doubleclick.net";
    const trackingConnect =
      "https://www.google-analytics.com https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com https://stats.g.doubleclick.net https://connect.facebook.net https://www.facebook.com https://*.facebook.com https://www.googleadservices.com https://googleads.g.doubleclick.net";
    const trackingFrame =
      "https://www.googletagmanager.com https://td.doubleclick.net https://www.facebook.com";
    const csp = [
      // default-src is the fallback for unspecified directives. No unsafe-* here —
      // only explicit child directives (script-src, style-src, etc.) carry those where required.
      "default-src 'self' blob: data: https://challenges.cloudflare.com https://*.cloudflare.com",
      // Nonce eliminates 'unsafe-inline' for CSP3 browsers. 'unsafe-inline' is a CSP2 fallback.
      `script-src 'self' ${nonceDirective} ${scriptUnsafe}blob: data: https://app.anutech.in https://checkout.razorpay.com https://*.razorpay.com https://challenges.cloudflare.com https://cloudflare.com https://*.cloudflare.com https://accounts.google.com https://apis.google.com https://www.google.com https://recaptcha.net https://www.gstatic.com https://static.cloudflareinsights.com ${trackingScript}`,
      // unsafe-inline required for Tailwind utility classes and Next.js style injection.
      // Google Fonts removed: web app uses next/font (self-hosted at build time); no CDN font request is made.
      "style-src 'self' 'unsafe-inline' https://accounts.google.com https://www.google.com https://www.gstatic.com https://challenges.cloudflare.com",
      "img-src 'self' data: https: blob:",
      // Google Fonts CDN (fonts.gstatic.com) removed: fonts are self-hosted via next/font.
      "font-src 'self' data:",
      "upgrade-insecure-requests",
      `connect-src 'self' data: blob: wss: https://app.anutech.in https://api.razorpay.com https://checkout.razorpay.com https://*.razorpay.com https://lumberjack.razorpay.com https://*.sentry.io https://challenges.cloudflare.com https://cloudflare.com https://*.cloudflare.com https://httpapi.com https://accounts.google.com https://apis.google.com https://www.google.com https://recaptcha.net https://www.gstatic.com https://cloudflareinsights.com https://nominatim.openstreetmap.org https://api.bigdatacloud.net ${trackingConnect}`,
      // `blob:` allows the in-app PDF previewer (admin & user invoice pages)
      // to load `URL.createObjectURL(blob)` URLs in an <iframe>. Without it
      // the iframe is silently blocked by the browser and the preview hangs.
      `frame-src 'self' blob: https://checkout.razorpay.com https://api.razorpay.com https://*.razorpay.com https://challenges.cloudflare.com https://cloudflare.com https://*.cloudflare.com https://www.openstreetmap.org https://accounts.google.com https://www.google.com https://recaptcha.net ${trackingFrame}`,
      "child-src 'self' blob: data: https://challenges.cloudflare.com https://*.cloudflare.com https://www.google.com https://recaptcha.net",
      "worker-src 'self' blob: data: https://challenges.cloudflare.com https://*.cloudflare.com https://www.google.com https://recaptcha.net",
      "object-src 'none'",
      "base-uri 'self'",
      // www.facebook.com: the Meta Pixel (fbevents.js) falls back to submitting
      // a hidden <form> to https://www.facebook.com/tr/ when its img/fetch
      // beacon can't be used; without it in form-action the browser blocks the
      // event (CSP "form-action 'self' …" violation in the console) and the
      // Pixel event is lost. connect-src/img-src/script-src already allow
      // Facebook for the Pixel, so this just completes the set.
      "form-action 'self' https://api.razorpay.com https://checkout.razorpay.com https://*.razorpay.com https://accounts.google.com https://www.facebook.com",
      // Prevents this page from being embedded in foreign iframes (clickjacking).
      // Razorpay loads its checkout as a frame inside our page — that is covered by frame-src above,
      // not by frame-ancestors. SAMEORIGIN is safe here.
      "frame-ancestors 'self'",
    ].join("; ");

    setHeader("Content-Security-Policy", csp);
  }

  // Remove server information if present
  if (response.headers.has("X-Powered-By")) {
    response.headers.delete("X-Powered-By");
  }

  return response;
}

