import { AUTH_SECRET } from "@/lib/auth-secret";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { addSecurityHeaders, addCorsHeaders, buildPreflightResponse } from "@/lib/security-headers";
import { SecurityValidator } from "@/lib/security";

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
  "/maintenance",
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

// Pages eligible for strict CSP (nonce-only script-src; no unsafe-eval/inline).
// These are static legal/marketing/error pages that load no third-party JS.
// API routes get strict CSP automatically (JSON responses, no scripts run).
const STRICT_CSP_PAGE_PATHS = new Set([
  "/about",
  "/cancellation-refund",
  "/data-deletion",
  "/privacy",
  "/terms-and-conditions",
  "/maintenance",
  "/403",
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
  "/api/domains/search",
  "/api/domains/bulk-search",
  "/api/domains/pricing",
  "/api/domains/tlds",
  "/api/check-ip",
  "/api/contact",
  "/api/settings/captcha-status",
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

const logAuthAttempt = (pathname: string, status: 401 | 403) => {
  const sanitized = sanitizePathForLog(pathname);
  // Log status and sanitized path only - no role leakage
  console.warn(`[Middleware Security] ${status} attempt on ${sanitized}`);
};

const normalizePath = (path: string) => {
  return path.replace(/\/+/g, "/");
};

// Generate a cryptographically random nonce per request for nonce-based CSP.
// Base64-encodes a UUID so only alphanumeric/+/= chars appear in the header.
function generateNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}

// Create a NextResponse.next() that forwards the nonce to the rendering context
// via the x-nonce request header. Next.js 15 App Router reads this and automatically
// attaches the nonce to its generated inline hydration scripts.
function nextWithNonce(request: NextRequest, nonce: string): NextResponse {
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  return NextResponse.next({ request: { headers } });
}

// --- Maintenance Mode Cache ---
// Module-level cache (persists across requests in Node.js standalone / PM2 process).
// Falls back to a fresh fetch on every request in edge-like environments where module
// state is not preserved between invocations, which is still acceptable.
let _mCache: { enabled: boolean; message: string; scheduledEnd: string | null; expires: number } | null = null;
const MAINTENANCE_CACHE_TTL = 15_000; // 15 seconds

async function getMaintenanceStatus(_origin: string): Promise<{ enabled: boolean; message: string; scheduledEnd: string | null }> {
  const now = Date.now();
  if (_mCache && _mCache.expires > now) {
    return { enabled: _mCache.enabled, message: _mCache.message, scheduledEnd: _mCache.scheduledEnd };
  }
  try {
    // Use the loopback HTTP address so this request bypasses Nginx TLS and
    // avoids HTTPS self-referral issues on the server.
    const port = process.env.PORT || '3000';
    const res = await fetch(`http://127.0.0.1:${port}/api/public/maintenance-status`, {
      headers: { 'x-internal-maintenance-check': '1' },
    });
    if (res.ok) {
      const data = await res.json();
      _mCache = {
        enabled: !!data.enabled,
        message: data.message || '',
        scheduledEnd: data.scheduledEnd || null,
        expires: now + MAINTENANCE_CACHE_TTL,
      };
      return { enabled: _mCache.enabled, message: _mCache.message, scheduledEnd: _mCache.scheduledEnd };
    }
  } catch { /* fail open */ }
  return { enabled: false, message: '', scheduledEnd: null };
}

export async function middleware(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const nonce = generateNonce();
  const response = await handleMiddleware(request, nonce);
  response.headers.set("x-request-id", requestId);

  // Apply CORS headers to all API responses (non-OPTIONS — preflight is handled above)
  if (request.nextUrl.pathname.startsWith("/api/")) {
    addCorsHeaders(response, request);
  }

  return response;
}

async function handleMiddleware(request: NextRequest, nonce: string): Promise<NextResponse> {
  // 0a. HTTPS enforcement — redirect HTTP to HTTPS in production.
  // x-forwarded-proto covers reverse-proxy / Docker deployments where TLS
  // terminates at the load balancer and the internal request arrives as HTTP.
  // Skip for internal server-to-server calls (e.g. the maintenance-mode health
  // check fetch): these arrive on loopback without TLS and must not be redirected.
  if (process.env.NODE_ENV === "production") {
    const hostname = request.nextUrl.hostname;
    // Loopback hostnames used when Next.js calls itself internally (0.0.0.0 is
    // the server bind address that appears in request.nextUrl for loopback calls)
    const isInternalHost =
      hostname === "127.0.0.1" ||
      hostname === "localhost" ||
      hostname === "0.0.0.0";
    // Requests that carry our internal maintenance-check sentinel header are also
    // always server→server and must bypass TLS enforcement.
    const hasInternalHeader =
      request.headers.get("x-internal-maintenance-check") === "1";
    if (!isInternalHost && !hasInternalHeader) {
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

  // Strict CSP eligibility: pages that do NOT load Razorpay checkout,
  // reCAPTCHA, or any third-party JS that relies on eval/new Function().
  // These get a nonce-only script-src — no 'unsafe-eval', no 'unsafe-inline'.
  // Dashboard, admin, auth, cart, checkout pages all stay on the relaxed CSP
  // because Razorpay or reCAPTCHA can appear dynamically (e.g. renewal modals).
  // Computed BEFORE the URL-normalize redirect so the redirect response carries
  // the right CSP for the destination route, and so later addSecurityHeaders
  // calls don't hit a temporal-dead-zone reference.
  const isStrictCSPRoute =
    classificationPath.startsWith("/api/") ||
    STRICT_CSP_PAGE_PATHS.has(normalizedPathname);

  if (rawPathname !== normalizedPathname) {
    const url = request.nextUrl.clone();
    url.pathname = normalizedPathname;
    return addSecurityHeaders(NextResponse.redirect(url, 307), { nonce, strictCSP: isStrictCSPRoute }); // Use 307 (Temporary) to avoid permanent redirection cache
  }

  const pathname = normalizedPathname;

  // 1b. Maintenance mode — redirect non-admin, non-API routes to /maintenance when enabled.
  // Skip: /admin/* (admins must always reach the panel), /api/* (internal calls),
  //        /maintenance (avoid redirect loop), internal maintenance-check requests.
  const isMaintenanceBypass =
    pathname === '/maintenance' ||
    // Admin panel and its API must always be reachable so admins can disable maintenance
    pathname.startsWith('/admin') ||
    // Login/register must be reachable so admins can authenticate during maintenance.
    // (Regular users who log in will still hit maintenance on /dashboard afterwards.)
    pathname === '/login' ||
    pathname === '/register' ||
    pathname.startsWith('/api/') ||
    request.headers.get('x-internal-maintenance-check') === '1';

  if (!isMaintenanceBypass) {
    const maintenance = await getMaintenanceStatus('');
    if (maintenance.enabled) {
      const url = request.nextUrl.clone();
      url.pathname = '/maintenance';
      return addSecurityHeaders(NextResponse.redirect(url, { status: 307 }), { nonce, strictCSP: isStrictCSPRoute });
    }
  }

  // 2. Classification
  // Explicitly allow HEAD requests for public routes (monitoring)
  const isHeadRequest = request.method === "HEAD";

  const isAdminApi = ADMIN_API_PREFIXES.some(p => classificationPath === p || classificationPath.startsWith(p + "/"));
  const isAdminPage = ADMIN_PREFIXES.some(p => pathname === p || pathname.startsWith(p + "/"));
  const isAuthPage = AUTH_PAGES.has(pathname);
  const isGuestPublicRoute = GUEST_PUBLIC_ROUTES.has(pathname) || Array.from(GUEST_PUBLIC_ROUTES).some(p => pathname.startsWith(p + "/"));
  const isProtectedRoute = !isGuestPublicRoute && PROTECTED_PREFIXES.some(p => pathname === p || pathname.startsWith(p + "/"));
  const isApi = pathname.startsWith("/api/");
  const isPublicApi = PUBLIC_API_PREFIXES.some(p => classificationPath === p || classificationPath.startsWith(p + "/"));
  const isPublicRoute = PUBLIC_ROUTES.has(pathname) || PUBLIC_PREFIXES.some(p => pathname.startsWith(p));

  // --- 3. Token Fetching (Single call, only when security/logic requires it) ---
  const needsToken = (isAdminApi || isAdminPage || isAuthPage || isProtectedRoute || (isApi && !isPublicApi)) && !isHeadRequest;

  let token = null;
  if (needsToken) {
    token = await getToken({
      req: request,
      secret: AUTH_SECRET,
    });
  }

  // --- 4. Authorization & Redirect Logic ---

  // Admin API: Return 401/403 (No Redirects)
  if (isAdminApi) {
    // CSRF validation for all mutating admin requests (POST, PUT, PATCH, DELETE).
    // GET/HEAD/OPTIONS are skipped inside validateCSRF automatically.
    const csrfCheck = SecurityValidator.validateCSRF(request);
    if (!csrfCheck.isValid) {
      console.warn(`[Middleware Security] CSRF validation failed on ${sanitizePathForLog(pathname)}: ${csrfCheck.error}`);
      return addSecurityHeaders(NextResponse.json({ error: "CSRF validation failed" }, { status: 403 }), { nonce, strictCSP: isStrictCSPRoute });
    }

    if (!token) {
      logAuthAttempt(pathname, 401);
      return addSecurityHeaders(NextResponse.json({ error: "Unauthorized" }, { status: 401 }), { nonce, strictCSP: isStrictCSPRoute });
    }
    if (token.role !== "admin") {
      logAuthAttempt(pathname, 403);
      return addSecurityHeaders(NextResponse.json({ error: "Forbidden" }, { status: 403 }), { nonce, strictCSP: isStrictCSPRoute });
    }
    return addSecurityHeaders(nextWithNonce(request, nonce), { nonce, strictCSP: isStrictCSPRoute });
  }

  // Auth pages: Redirect away if already logged in
  if (isAuthPage && token) {
    const redirectPath = token.role === "admin" ? "/admin/dashboard" : "/dashboard";
    return addSecurityHeaders(NextResponse.redirect(new URL(redirectPath, request.url)), { nonce, strictCSP: isStrictCSPRoute });
  }

  // Public / Public API / HEAD requests / Guest checkout: Bypass further checks
  if (isPublicRoute || isPublicApi || isHeadRequest || isGuestPublicRoute) {
    return addSecurityHeaders(nextWithNonce(request, nonce), { nonce, strictCSP: isStrictCSPRoute });
  }

  // Admin Pages: Enforce admin role
  if (isAdminPage) {
    if (!token) {
      logAuthAttempt(pathname, 401);
      return addSecurityHeaders(NextResponse.redirect(new URL("/403", request.url)), { nonce, strictCSP: isStrictCSPRoute });
    }
    if (token.role !== "admin") {
      logAuthAttempt(pathname, 403);
      return addSecurityHeaders(NextResponse.redirect(new URL("/403", request.url)), { nonce, strictCSP: isStrictCSPRoute });
    }
    return addSecurityHeaders(nextWithNonce(request, nonce), { nonce, strictCSP: isStrictCSPRoute });
  }

  // Protected User Routes
  if (isProtectedRoute) {
    if (!token) {
      logAuthAttempt(pathname, 401);
      return addSecurityHeaders(NextResponse.redirect(new URL("/403", request.url)), { nonce, strictCSP: isStrictCSPRoute });
    }

    // Safety: prevent admins from accessing regular dashboards
    if (token.role === "admin" && pathname.startsWith("/dashboard")) {
      return addSecurityHeaders(NextResponse.redirect(new URL("/admin/dashboard", request.url)), { nonce, strictCSP: isStrictCSPRoute });
    }
    return addSecurityHeaders(nextWithNonce(request, nonce), { nonce, strictCSP: isStrictCSPRoute });
  }

  // General API Safety: No redirects for internal APIs
  if (isApi) {
    if (!token) {
      logAuthAttempt(pathname, 401);
      return addSecurityHeaders(NextResponse.json({ error: "Unauthorized" }, { status: 401 }), { nonce, strictCSP: isStrictCSPRoute });
    }
  }

  // Default fallback
  const isPdfRoute = pathname.match(/^\/api\/user\/invoices\/[^/]+\/pdf$/) !== null;
  const isCheckoutRoute = pathname === "/checkout" || pathname.startsWith("/checkout/");
  return addSecurityHeaders(nextWithNonce(request, nonce), { skipCSP: isPdfRoute || isCheckoutRoute, nonce, strictCSP: isStrictCSPRoute });
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|[^?]*\\.(?:png|jpe?g|gif|svg|webp|avif|ico|bmp|tiff|woff2?|ttf|otf)).*)",
  ],
};
