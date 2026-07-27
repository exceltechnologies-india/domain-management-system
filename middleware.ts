import { AUTH_SECRET } from "@/lib/auth-secret";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { addSecurityHeaders, addCorsHeaders, buildPreflightResponse } from "@/lib/security-headers";
import { SecurityValidator } from "@/lib/security";
import { serverLogger } from "@/lib/server-logger";
import { resolveRequestId, REQUEST_ID_HEADER } from "@/lib/request-id";

// --- Route Configuration ---
const PUBLIC_ROUTES = new Set([
  "/",
  "/login",
  "/register",
  "/about",
  "/contact",
  "/reset-password",
  "/complete-profile",
  "/activate",
  "/403",
]);

const PUBLIC_PREFIXES = [
  "/about/",
  "/contact/",
  "/reset-password/",
  "/complete-profile/",
  "/activate/",
];

const AUTH_PAGES = new Set(["/login", "/register"]);
const PROTECTED_PREFIXES = ["/dashboard", "/checkout"];
// Guest checkout is public — unauthenticated users access it by design
const GUEST_PUBLIC_ROUTES = new Set(["/checkout/guest"]);
const ADMIN_PREFIXES = ["/admin"];
const ADMIN_API_PREFIXES = ["/api/admin"];

// Specific admin-API paths that handle their own authorisation inside the
// route handler (cron-secret OR session OR same-origin) and should NOT be
// middleware-gated to admin-only. Without this, the server-side
// serverLogger.error → /api/v1/admin/log-error forwarder (a no-cookie
// server-to-self fetch) gets 403'd by the admin-API check before its own
// validation can run — which is why client + server errors weren't reaching
// the SystemLog collection on 2026-06-17 (Zoho invoice failure), 2026-06-18
// (paymentVerification subdoc + linkedDomain saves), or 2026-06-19 (admin
// dashboard render error). Each entry must match the post-/api/v1 strip
// (classificationPath) so it applies to both /api/admin/X and
// /api/v1/admin/X.
const SELF_AUTHENTICATING_ADMIN_API = new Set<string>([
  "/api/admin/log-error",
]);

// Pages that REQUIRE relaxed CSP (unsafe-eval / unsafe-inline) because they
// load third-party JS that uses eval/new Function(). Everything else — and
// all API routes — defaults to STRICT (nonce-only script-src).
//
// - /razorpay-checkout: hosts checkout.razorpay.com inside an iframe. The
//   rest of the app interacts with Razorpay through this isolated route
//   (see components/RazorpayCheckoutFrame.tsx), so /checkout, /dashboard/*,
//   /cart, etc. all run strict.
// - login / register / forgot-password / reset-password / contact: render
//   the Google reCAPTCHA v2 widget, which loads google.com/recaptcha/api.js
//   and requires unsafe-eval. Migrating reCAPTCHA behind a similar iframe
//   shim would be the next step to make these strict too.
const RELAXED_CSP_PAGE_PATHS = new Set([
  "/razorpay-checkout",
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/contact",
]);

// API routes that are explicitly public (auth, webhooks, or operational)
const PUBLIC_API_PREFIXES = [
  "/api/auth",
  "/api/webhooks",
  "/api/public",
  "/api/health",
  "/api/status",
  "/api/metrics",
  "/api/log",
  // Email unsubscribe: clicked from an email (no session) and POSTed by mail
  // clients via RFC 8058 one-click (no CSRF token). Authenticated by the
  // signed HMAC token in the URL, verified inside the route.
  "/api/notifications/unsubscribe",
  // Public chatbot: the homepage chat widget is anonymous-friendly by
  // design (pre-sales visitors haven't logged in yet). Auth-free + rate-
  // limited at the route layer (10 req/min/IP); content-screened by
  // the three-layer guard rails in app/api/chat/route.ts.
  "/api/chat",
  // Public-tolerant cart sync: the cart store calls /api/cart on every
  // load/save/merge regardless of login state, by design (the
  // localStorage cart is the source of truth for guests; the server
  // cart only matters once a customer logs in). Middleware lets the
  // request through; the route handler itself returns a 200 no-op
  // (empty cart / write-skipped) for unauthenticated requests instead
  // of a 401 — keeps the browser console clean for guests browsing
  // the cart.
  "/api/cart",
  "/api/domains/search",
  "/api/domains/bulk-search",
  "/api/domains/pricing",
  "/api/domains/tlds",
  "/api/check-ip",
  "/api/contact",
  "/api/settings/captcha-status",
  // Public footer switcher: the footer reads which template to render.
  "/api/settings/footer",
  // Public support-widget switcher: chatbot vs WhatsApp + company number.
  "/api/settings/support-widget",
  // Public contact-detail visibility: GSTIN + phone number toggles.
  "/api/settings/visibility",
  // Public analytics beacon: the browser records client-side journey events
  // (landing/view/trial/checkout). Auth is best-effort inside the route.
  "/api/analytics/track",
  // Cron and worker routes authenticate via x-cron-secret header in the route handler.
  // They must bypass middleware JWT checks so Google Cloud Scheduler/Tasks can call them.
  "/api/cron",
  "/api/workers",
  // Email-change verification link is clicked while unauthenticated (from email client)
  "/api/user/settings/verify-email-change",
  // Guest checkout: no account required — route handler validates guest JWT token
  "/api/payments/guest",
];

// --- Helpers ---

/**
 * Sanitize path for logging to avoid leaking sensitive internal structures.
 * Groups common patterns and truncates long dynamic paths.
 */
const sanitizePathForLog = (path: string) => {
  if (path.startsWith("/api/admin")) return "/api/admin/*";
  if (path.startsWith("/admin")) return "/admin/*";
  if (path.startsWith("/dashboard")) return "/dashboard/*";
  return path.split("/").slice(0, 3).join("/");
};

const logAuthAttempt = (pathname: string, status: 401 | 403, requestId: string) => {
  const sanitized = sanitizePathForLog(pathname);
  // Log status and sanitized path only - no role leakage. requestId is passed
  // as a meta arg so the structured-JSON output carries it as a top-level field.
  serverLogger.warn(`[Middleware Security] ${status} attempt on ${sanitized}`, { requestId });
};

const normalizePath = (path: string) => {
  return path.replace(/\/+/g, "/");
};

// Generate a cryptographically random nonce per request for nonce-based CSP.
// 16 random bytes → 24 base64 chars, the standard idiom. The previous form
// base64-encoded the 36-char UUID *string* (with dashes), which produced a
// longer output without adding entropy. Middleware runs in Edge runtime
// so we use Web Crypto's getRandomValues — Node's `crypto.randomBytes` is
// not available here.
function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// Create a NextResponse.next() that forwards the nonce + request ID to the
// rendering context via request headers. Next.js 15 App Router reads `x-nonce`
// and automatically attaches it to its generated inline hydration scripts.
// `x-request-id` is exposed for handlers that want to include it in their
// own log entries (see lib/server-logger.ts).
function nextWithNonce(request: NextRequest, nonce: string, requestId: string): NextResponse {
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set(REQUEST_ID_HEADER, requestId);
  // Expose the pathname to server components (the root layout reads it to
  // decide whether to load analytics tags — off on /admin + /dashboard by
  // default). Next doesn't surface the pathname via headers() otherwise.
  headers.set("x-pathname", request.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export async function middleware(request: NextRequest) {
  // Prefer Cloud Run's X-Cloud-Trace-Context so log entries correlate with
  // Cloud Trace spans automatically. Falls back to an upstream x-request-id
  // (if a load balancer set one) or a fresh UUID.
  const requestId = resolveRequestId(request.headers);
  const nonce = generateNonce();
  const response = await handleMiddleware(request, nonce, requestId);
  response.headers.set(REQUEST_ID_HEADER, requestId);

  // Apply CORS headers to all API responses (non-OPTIONS — preflight is handled above)
  if (request.nextUrl.pathname.startsWith("/api/")) {
    addCorsHeaders(response, request);
  }

  return response;
}

async function handleMiddleware(request: NextRequest, nonce: string, requestId: string): Promise<NextResponse> {
  // 0a. HTTPS enforcement — redirect HTTP to HTTPS in production.
  // x-forwarded-proto covers reverse-proxy / Docker deployments where TLS
  // terminates at the load balancer and the internal request arrives as HTTP.
  // Skip for internal server-to-server loopback calls: these arrive on loopback
  // without TLS and must not be redirected.
  if (process.env.NODE_ENV === "production") {
    const hostname = request.nextUrl.hostname;
    // Loopback hostnames used when Next.js calls itself internally (0.0.0.0 is
    // the server bind address that appears in request.nextUrl for loopback calls)
    const isInternalHost =
      hostname === "127.0.0.1" ||
      hostname === "localhost" ||
      hostname === "0.0.0.0";
    if (!isInternalHost) {
      const proto =
        request.headers.get("x-forwarded-proto") ??
        request.nextUrl.protocol.replace(":", "");
      if (proto !== "https") {
        const url = request.nextUrl.clone();
        url.protocol = "https:";
        return NextResponse.redirect(url, { status: 301 });
      }
    }
  }

  // 0b. CORS Preflight — respond immediately with correct CORS headers
  if (request.method === "OPTIONS") {
    return buildPreflightResponse(request);
  }

  // 1. URI Normalization check & redirect
  const rawPathname = request.nextUrl.pathname;
  const normalizedPathname = normalizePath(rawPathname);

  // API versioning: /api/v1/<anything> is rewritten by next.config.js to
  // /api/<anything> at the routing layer, but middleware runs BEFORE the
  // rewrite. Build a classification path that strips the v1 prefix so the
  // admin/public-API prefix checks below treat versioned and unversioned
  // requests identically. We still log the original pathname so audit trails
  // can distinguish v1-specific traffic.
  const classificationPath = normalizedPathname.startsWith("/api/v1/")
    ? normalizedPathname.replace(/^\/api\/v1/, "/api")
    : normalizedPathname;

  // Strict CSP is now the default. Only pages on the explicit RELAXED list
  // (Razorpay iframe host + reCAPTCHA-rendering forms) get unsafe-eval /
  // unsafe-inline. Everything else — dashboard, admin, cart, /checkout
  // (which now delegates to the /razorpay-checkout iframe), payment-success,
  // domains/*, home, legal pages, and all API routes — runs nonce-only.
  // Computed BEFORE the URL-normalize redirect so the redirect response
  // carries the right CSP for the destination, and so later
  // addSecurityHeaders calls don't hit a temporal-dead-zone reference.
  const isStrictCSPRoute =
    classificationPath.startsWith("/api/") ||
    !RELAXED_CSP_PAGE_PATHS.has(normalizedPathname);

  if (rawPathname !== normalizedPathname) {
    const url = request.nextUrl.clone();
    url.pathname = normalizedPathname;
    return addSecurityHeaders(NextResponse.redirect(url, 307), { nonce, strictCSP: isStrictCSPRoute }); // Use 307 (Temporary) to avoid permanent redirection cache
  }

  const pathname = normalizedPathname;

  // 2. Classification
  // Explicitly allow HEAD requests for public routes (monitoring)
  const isHeadRequest = request.method === "HEAD";

  const isAdminApi =
    ADMIN_API_PREFIXES.some(p => classificationPath === p || classificationPath.startsWith(p + "/")) &&
    !SELF_AUTHENTICATING_ADMIN_API.has(classificationPath);
  const isAdminPage = ADMIN_PREFIXES.some(p => pathname === p || pathname.startsWith(p + "/"));
  const isAuthPage = AUTH_PAGES.has(pathname);
  const isGuestPublicRoute = GUEST_PUBLIC_ROUTES.has(pathname) || Array.from(GUEST_PUBLIC_ROUTES).some(p => pathname.startsWith(p + "/"));
  const isProtectedRoute = !isGuestPublicRoute && PROTECTED_PREFIXES.some(p => pathname === p || pathname.startsWith(p + "/"));
  const isApi = pathname.startsWith("/api/");
  const isPublicApi = PUBLIC_API_PREFIXES.some(p => classificationPath === p || classificationPath.startsWith(p + "/"));
  const isPublicRoute = PUBLIC_ROUTES.has(pathname) || PUBLIC_PREFIXES.some(p => pathname.startsWith(p));

  // Machine-to-machine admin calls (operator scripts + cron one-offs like
  // scripts/purge-test-users.js) authenticate via the x-cron-secret bearer
  // header, NOT a session cookie. When a VALID cron secret is present on an
  // admin API, bypass the browser-oriented CSRF + admin-JWT gates and let the
  // route's own authorizeCronRequest be the boundary. Scoped strictly to admin
  // APIs (`isAdminApi`) so it never widens auth for anything else, and the
  // secret is a strong bearer token held only by Cloud Scheduler + operator
  // machines — an attacker who has it doesn't need CSRF anyway. This closes the
  // gap where /api/v1/admin/hosting/actions was BUILT to accept x-cron-secret
  // (for the DA-delete purge script — operator machines aren't DA-whitelisted,
  // so DA calls must originate from Cloud Run) but the isAdminApi JWT check
  // still 401'd it before the route's cron-auth could run. Browser admin calls
  // (no cron header) fall through to the normal CSRF + JWT gates unchanged.
  // Placed before token-fetch so machine calls skip the getToken round-trip.
  // See [[project_da_operations_via_prod_route]].
  const cronSecretEnv = process.env.CRON_SECRET;
  if (
    isAdminApi &&
    !!cronSecretEnv &&
    request.headers.get("x-cron-secret") === cronSecretEnv
  ) {
    return addSecurityHeaders(nextWithNonce(request, nonce, requestId), { nonce, strictCSP: isStrictCSPRoute });
  }

  // --- 3. Token Fetching (Single call, only when security/logic requires it) ---
  const needsToken = (isAdminApi || isAdminPage || isAuthPage || isProtectedRoute || (isApi && !isPublicApi)) && !isHeadRequest;

  let token = null;
  if (needsToken) {
    token = await getToken({
      req: request,
      secret: AUTH_SECRET,
    });
  }

  // CSRF gate for every authenticated mutating /api/* request, regardless
  // of admin/user/payment classification. GET/HEAD/OPTIONS pass through
  // validateCSRF unconditionally so safe-method reads aren't blocked. Public
  // APIs (auth, webhooks, cron, workers, /api/public/*, etc.) are exempt
  // — those either authenticate via a non-cookie scheme (webhook signature,
  // x-cron-secret) or are intentionally cookie-less, so SameSite + the
  // route-level auth check is the right boundary there.
  // Previously this check only ran inside the `isAdminApi` branch, leaving
  // /api/user/* and /api/payments/* defended only by NextAuth's `sameSite:
  // lax` cookie — which still allows top-level navigation POSTs.
  // SELF_AUTHENTICATING_ADMIN_API endpoints (currently /api/admin/log-error)
  // are also exempt from the CSRF gate — they authenticate via x-cron-secret
  // or same-origin server-to-self fetch, NOT via session cookie + Origin
  // header. The earlier dms-00179-fwc fix added the exemption to the
  // admin-role check (line ~358 below) but forgot this CSRF gate which
  // fires first in the pipeline, so log-error continued to 403 silently
  // for every serverLogger.error() call. Today's hosting-provisioning
  // failure (dms-00190+) is the second case we've hit; restoring the
  // exemption here closes the gap properly.
  if (isApi && !isPublicApi && !SELF_AUTHENTICATING_ADMIN_API.has(classificationPath)) {
    const csrfCheck = SecurityValidator.validateCSRF(request);
    if (!csrfCheck.isValid) {
      serverLogger.warn(`[Middleware Security] CSRF validation failed on ${sanitizePathForLog(pathname)}: ${csrfCheck.error}`, { requestId });
      return addSecurityHeaders(NextResponse.json({ error: "CSRF validation failed" }, { status: 403 }), { nonce, strictCSP: isStrictCSPRoute });
    }
  }

  // Admin API: Return 401/403 (No Redirects)
  if (isAdminApi) {
    if (!token) {
      logAuthAttempt(pathname, 401, requestId);
      return addSecurityHeaders(NextResponse.json({ error: "Unauthorized" }, { status: 401 }), { nonce, strictCSP: isStrictCSPRoute });
    }
    if (token.role !== "admin") {
      logAuthAttempt(pathname, 403, requestId);
      return addSecurityHeaders(NextResponse.json({ error: "Forbidden" }, { status: 403 }), { nonce, strictCSP: isStrictCSPRoute });
    }
    return addSecurityHeaders(nextWithNonce(request, nonce, requestId), { nonce, strictCSP: isStrictCSPRoute });
  }

  // Auth pages: Redirect away if already logged in
  if (isAuthPage && token) {
    const redirectPath = token.role === "admin" ? "/admin/dashboard" : "/dashboard";
    return addSecurityHeaders(NextResponse.redirect(new URL(redirectPath, request.url)), { nonce, strictCSP: isStrictCSPRoute });
  }

  // Public / Public API / HEAD requests / Guest checkout: Bypass further checks
  if (isPublicRoute || isPublicApi || isHeadRequest || isGuestPublicRoute) {
    return addSecurityHeaders(nextWithNonce(request, nonce, requestId), { nonce, strictCSP: isStrictCSPRoute });
  }

  // Admin Pages: Enforce admin role
  if (isAdminPage) {
    if (!token) {
      // No / expired session = NOT AUTHENTICATED, not "forbidden". Send to
      // /login with a returnUrl so the admin lands back where they were after
      // signing in — mirrors the protected-user-route flow below. Previously
      // this redirected to /403 "Access Denied", which is misleading UX for a
      // simply-lapsed admin session (the common case). /403 is reserved for
      // an AUTHENTICATED user who lacks the admin role (the branch below).
      logAuthAttempt(pathname, 401, requestId);
      const safeReturn = pathname.startsWith("/") && !pathname.startsWith("//") ? pathname : "/admin/dashboard";
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("returnUrl", safeReturn);
      return addSecurityHeaders(NextResponse.redirect(loginUrl), { nonce, strictCSP: isStrictCSPRoute });
    }
    if (token.role !== "admin") {
      logAuthAttempt(pathname, 403, requestId);
      return addSecurityHeaders(NextResponse.redirect(new URL("/403", request.url)), { nonce, strictCSP: isStrictCSPRoute });
    }
    return addSecurityHeaders(nextWithNonce(request, nonce, requestId), { nonce, strictCSP: isStrictCSPRoute });
  }

  // Protected User Routes
  if (isProtectedRoute) {
    if (!token) {
      logAuthAttempt(pathname, 401, requestId);
      // Unauthenticated user → send to /login with returnUrl so they can
      // come back to where they were trying to go after signing in.
      // Previously this redirected to /403 ("Access Denied"), which is
      // misleading UX — the customer wasn't denied access, they just
      // weren't signed in. Specifically this bit the post-activation flow:
      // the activate page pushed to /dashboard before a NextAuth session
      // was established, so customers fresh from clicking the activation
      // email landed on the hostile 403 page instead of a friendly login.
      const safeReturn = pathname.startsWith("/") && !pathname.startsWith("//") ? pathname : "/dashboard";
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("returnUrl", safeReturn);
      return addSecurityHeaders(NextResponse.redirect(loginUrl), { nonce, strictCSP: isStrictCSPRoute });
    }

    // Safety: prevent admins from accessing regular dashboards
    if (token.role === "admin" && pathname.startsWith("/dashboard")) {
      return addSecurityHeaders(NextResponse.redirect(new URL("/admin/dashboard", request.url)), { nonce, strictCSP: isStrictCSPRoute });
    }
    return addSecurityHeaders(nextWithNonce(request, nonce, requestId), { nonce, strictCSP: isStrictCSPRoute });
  }

  // General API Safety: No redirects for internal APIs
  if (isApi) {
    if (!token) {
      logAuthAttempt(pathname, 401, requestId);
      return addSecurityHeaders(NextResponse.json({ error: "Unauthorized" }, { status: 401 }), { nonce, strictCSP: isStrictCSPRoute });
    }
  }

  // Default fallback
  const isPdfRoute = pathname.match(/^\/api\/user\/invoices\/[^/]+\/pdf$/) !== null;
  const isCheckoutRoute = pathname === "/checkout" || pathname.startsWith("/checkout/");
  return addSecurityHeaders(nextWithNonce(request, nonce, requestId), { skipCSP: isPdfRoute || isCheckoutRoute, nonce, strictCSP: isStrictCSPRoute });
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|[^?]*\\.(?:png|jpe?g|gif|svg|webp|avif|ico|bmp|tiff|woff2?|ttf|otf)).*)",
  ],
};
