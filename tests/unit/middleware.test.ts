/**
 * Tests for `middleware.ts` (rescan-4 slice 7fw). THE security boundary
 * — every request flows through this before any route handler runs.
 * Pins:
 *  - **HTTPS enforcement (production-only)**: x-forwarded-proto !== 'https'
 *    on a public hostname → 301 redirect to https:// URL. Loopback
 *    (127.0.0.1/localhost/0.0.0.0) bypasses — server→server calls
 *    don't get redirected.
 *  - **CORS preflight (OPTIONS)** returns immediately via buildPreflightResponse
 *    — no token fetch, no CSRF check
 *  - **URI normalization**: collapse `//` → `/` (and other dupes) then
 *    307 redirect to canonical path (NOT 301 — avoid permanent
 *    redirect cache for what is a passing-error correction)
 *  - **API v1 prefix rewrite**: `/api/v1/x` is classified as `/api/x`
 *    for prefix matching but log preserves v1
 *  - **HEAD bypass for public routes (monitoring)**: HEAD requests on
 *    public routes pass through without a token fetch
 *  - **CSRF gate on EVERY authenticated mutating /api/* request**:
 *    NOT just admin (this was the foot-gun fix — previously CSRF only
 *    fired inside the admin branch, leaving /api/user/* and
 *    /api/payments/* defended only by sameSite:lax cookie which still
 *    allows top-level POST navigations)
 *  - **Admin API: 401/403 JSON, NO redirects** (REST clients
 *    can't follow page redirects)
 *  - **Admin pages: unauthenticated → /login (with returnUrl);
 *    authenticated-but-non-admin → /403**. An expired session is a
 *    login problem, not a permissions one; /403 is reserved for a
 *    real wrong-role case.
 *  - **Auth-page redirect by role**: logged-in user on /login →
 *    /admin/dashboard if admin, /dashboard else
 *  - **Admin-on-/dashboard guard**: admin accessing /dashboard/* →
 *    redirect to /admin/dashboard (prevents admin role pollution
 *    of regular-user surfaces)
 *  - **isStrictCSPRoute computed BEFORE redirect** so the redirect
 *    response carries the right CSP for the destination
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── hoisted mocks ────────────────────────────────────────────────────
const getToken = vi.hoisted(() => vi.fn());
vi.mock("next-auth/jwt", () => ({ getToken }));

vi.mock("@/lib/auth-secret", () => ({ AUTH_SECRET: "test-secret" }));

const validateCSRF = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => { isValid: boolean; error?: string }>(() => ({
    isValid: true,
  }))
);
vi.mock("@/lib/security", () => ({
  SecurityValidator: { validateCSRF },
}));

const addSecurityHeaders = vi.hoisted(() => vi.fn((res: any) => res));
const addCorsHeaders = vi.hoisted(() => vi.fn());
const buildPreflightResponse = vi.hoisted(() =>
  vi.fn(() => new Response(null, { status: 204 }))
);
vi.mock("@/lib/security-headers", () => ({
  addSecurityHeaders,
  addCorsHeaders,
  buildPreflightResponse,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const resolveRequestId = vi.hoisted(() =>
  vi.fn(() => "test-request-id")
);
vi.mock("@/lib/request-id", () => ({
  resolveRequestId,
  REQUEST_ID_HEADER: "x-request-id",
}));

// Re-attach the real NextResponse (global setup stubs it as plain fns)
vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { middleware } from "@/middleware";

// ── helpers ──────────────────────────────────────────────────────────
function makeReq(
  url: string,
  opts: { method?: string; headers?: Record<string, string> } = {}
): InstanceType<typeof NextRequest> {
  const headers = opts.headers ?? {};
  // NextRequest construction needs a full URL
  const req = new NextRequest(url, {
    method: opts.method ?? "GET",
    headers,
  });
  return req;
}

beforeEach(() => {
  getToken.mockReset();
  validateCSRF.mockReset().mockReturnValue({ isValid: true });
  addSecurityHeaders.mockReset().mockImplementation((res: any) => res);
  addCorsHeaders.mockReset();
  buildPreflightResponse
    .mockReset()
    .mockImplementation(() => new Response(null, { status: 204 }));
  resolveRequestId.mockReset().mockReturnValue("test-request-id");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── HTTPS enforcement ──────────────────────────────────────────────
describe("HTTPS enforcement (production-only)", () => {
  it("dev (NODE_ENV !== 'production') → NO HTTPS redirect even on http://", async () => {
    vi.stubEnv("NODE_ENV", "development");
    getToken.mockResolvedValueOnce(null);
    const req = makeReq("http://example.com/", {
      headers: { "x-forwarded-proto": "http" },
    });
    const res = await middleware(req);
    expect(res.status).not.toBe(301);
  });

  it("production + http x-forwarded-proto → 301 redirect to https://", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const req = makeReq("http://example.com/login", {
      headers: { "x-forwarded-proto": "http" },
    });
    const res = await middleware(req);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toMatch(/^https:/);
  });

  it("production + 127.0.0.1 (loopback) → NO redirect (server→server)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    getToken.mockResolvedValueOnce(null);
    const req = makeReq("http://127.0.0.1:3000/api/health", {
      headers: { "x-forwarded-proto": "http" },
    });
    const res = await middleware(req);
    expect(res.status).not.toBe(301);
  });

  it("production + localhost (loopback) → NO redirect", async () => {
    vi.stubEnv("NODE_ENV", "production");
    getToken.mockResolvedValueOnce(null);
    const req = makeReq("http://localhost:3000/api/health", {
      headers: { "x-forwarded-proto": "http" },
    });
    const res = await middleware(req);
    expect(res.status).not.toBe(301);
  });

  it("production + 0.0.0.0 (server bind) → NO redirect", async () => {
    vi.stubEnv("NODE_ENV", "production");
    getToken.mockResolvedValueOnce(null);
    const req = makeReq("http://0.0.0.0/api/health", {
      headers: { "x-forwarded-proto": "http" },
    });
    const res = await middleware(req);
    expect(res.status).not.toBe(301);
  });

  it("production + https → passes through", async () => {
    vi.stubEnv("NODE_ENV", "production");
    getToken.mockResolvedValueOnce(null);
    const req = makeReq("https://example.com/", {
      headers: { "x-forwarded-proto": "https" },
    });
    const res = await middleware(req);
    expect(res.status).not.toBe(301);
  });
});

// ─── CORS Preflight ─────────────────────────────────────────────────
describe("OPTIONS preflight", () => {
  it("returns immediately via buildPreflightResponse (no token, no CSRF check)", async () => {
    const req = makeReq("https://example.com/api/admin/users", {
      method: "OPTIONS",
    });
    await middleware(req);
    expect(buildPreflightResponse).toHaveBeenCalledTimes(1);
    expect(getToken).not.toHaveBeenCalled();
    expect(validateCSRF).not.toHaveBeenCalled();
  });
});

// ─── URI normalization ──────────────────────────────────────────────
describe("URI normalization", () => {
  it("collapses `//` → `/` with 307 redirect (NOT 301)", async () => {
    const req = makeReq("https://example.com//dashboard//hosting");
    const res = await middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard/hosting");
  });

  it("already-canonical path → no redirect", async () => {
    getToken.mockResolvedValueOnce(null);
    const req = makeReq("https://example.com/");
    const res = await middleware(req);
    expect(res.status).not.toBe(307);
  });
});

// ─── HEAD bypass for public routes ──────────────────────────────────
describe("HEAD requests on public routes — monitoring bypass", () => {
  it("HEAD on / → no token fetch (monitoring tools don't have credentials)", async () => {
    const req = makeReq("https://example.com/", { method: "HEAD" });
    await middleware(req);
    expect(getToken).not.toHaveBeenCalled();
  });

  it("HEAD on /api/admin/users → no token fetch (HEAD bypass even for admin)", async () => {
    const req = makeReq("https://example.com/api/admin/users", {
      method: "HEAD",
    });
    await middleware(req);
    expect(getToken).not.toHaveBeenCalled();
  });
});

// ─── CSRF gate ──────────────────────────────────────────────────────
describe("CSRF gate — EVERY authenticated mutating /api/*", () => {
  it("authenticated /api/user/* POST: CSRF check fires (anti-CSRF foot-gun fix)", async () => {
    getToken.mockResolvedValueOnce({ role: "user" });
    const req = makeReq("https://example.com/api/user/settings", {
      method: "POST",
    });
    await middleware(req);
    expect(validateCSRF).toHaveBeenCalled();
  });

  it("authenticated /api/payments/* POST: CSRF check fires", async () => {
    getToken.mockResolvedValueOnce({ role: "user" });
    const req = makeReq("https://example.com/api/payments/create-order", {
      method: "POST",
    });
    await middleware(req);
    expect(validateCSRF).toHaveBeenCalled();
  });

  it("authenticated /api/admin/* POST: CSRF check fires", async () => {
    getToken.mockResolvedValueOnce({ role: "admin" });
    const req = makeReq("https://example.com/api/admin/users", {
      method: "POST",
    });
    await middleware(req);
    expect(validateCSRF).toHaveBeenCalled();
  });

  it("CSRF failure → 403 JSON 'CSRF validation failed'", async () => {
    getToken.mockResolvedValueOnce({ role: "user" });
    validateCSRF.mockReturnValueOnce({
      isValid: false,
      error: "Origin mismatch",
    });
    const req = makeReq("https://example.com/api/user/settings", {
      method: "POST",
    });
    const res = await middleware(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("CSRF validation failed");
  });

  it("PUBLIC /api/auth/* → NO CSRF check (NextAuth handles it)", async () => {
    const req = makeReq("https://example.com/api/auth/signin", {
      method: "POST",
    });
    await middleware(req);
    expect(validateCSRF).not.toHaveBeenCalled();
  });

  it("PUBLIC /api/webhooks/* → NO CSRF check (signature-authed)", async () => {
    const req = makeReq("https://example.com/api/webhooks/razorpay", {
      method: "POST",
    });
    await middleware(req);
    expect(validateCSRF).not.toHaveBeenCalled();
  });

  it("PUBLIC /api/cron/* → NO CSRF check (x-cron-secret-authed)", async () => {
    const req = makeReq("https://example.com/api/cron/process-expiry", {
      method: "POST",
    });
    await middleware(req);
    expect(validateCSRF).not.toHaveBeenCalled();
  });

  it("PUBLIC /api/workers/* → NO CSRF check (x-cron-secret-authed)", async () => {
    const req = makeReq("https://example.com/api/workers/sync-zoho-invoice", {
      method: "POST",
    });
    await middleware(req);
    expect(validateCSRF).not.toHaveBeenCalled();
  });
});

// ─── Admin API: 401/403 JSON (NO redirects) ────────────────────────
describe("Admin API: 401/403 JSON (REST clients can't follow redirects)", () => {
  it("no token → 401 JSON {error: 'Unauthorized'}", async () => {
    getToken.mockResolvedValueOnce(null);
    const req = makeReq("https://example.com/api/admin/users");
    const res = await middleware(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("non-admin token → 403 JSON {error: 'Forbidden'}", async () => {
    getToken.mockResolvedValueOnce({ role: "user" });
    const req = makeReq("https://example.com/api/admin/users");
    const res = await middleware(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Forbidden");
  });

  it("admin token → passes through (no redirect, no error)", async () => {
    getToken.mockResolvedValueOnce({ role: "admin" });
    const req = makeReq("https://example.com/api/admin/users");
    const res = await middleware(req);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it("API v1 prefix: /api/v1/admin/users classified as admin (treated same as /api/admin)", async () => {
    getToken.mockResolvedValueOnce(null);
    const req = makeReq("https://example.com/api/v1/admin/users");
    const res = await middleware(req);
    expect(res.status).toBe(401);
  });
});

// ─── Admin pages: unauthenticated → /login; authenticated non-admin → /403 ──
describe("Admin pages — /login when unauthenticated, /403 when wrong role", () => {
  it("no / expired token → 307 redirect to /login with returnUrl (NOT /403)", async () => {
    // An expired admin session is UNAUTHENTICATED, not forbidden — sending it
    // to /403 'Access Denied' was misleading UX. It now goes to /login so the
    // admin can re-authenticate and land back where they were.
    getToken.mockResolvedValueOnce(null);
    const req = makeReq("https://example.com/admin/hosting");
    const res = await middleware(req);
    expect(res.status).toBe(307);
    const location = res.headers.get("location") || "";
    expect(location).toContain("/login");
    expect(location).toContain("returnUrl=%2Fadmin%2Fhosting");
    expect(location).not.toContain("/403");
  });

  it("authenticated non-admin token → /403 (wrong role — genuinely forbidden)", async () => {
    getToken.mockResolvedValueOnce({ role: "user" });
    const req = makeReq("https://example.com/admin/dashboard");
    const res = await middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/403");
    expect(res.headers.get("location")).not.toContain("/login");
  });
});

// ─── Auth-page redirect by role ────────────────────────────────────
describe("Auth pages — redirect away if logged in", () => {
  it("logged-in user on /login → 307 to /dashboard", async () => {
    getToken.mockResolvedValueOnce({ role: "user" });
    const req = makeReq("https://example.com/login");
    const res = await middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
  });

  it("logged-in ADMIN on /login → 307 to /admin/dashboard (NOT /dashboard)", async () => {
    getToken.mockResolvedValueOnce({ role: "admin" });
    const req = makeReq("https://example.com/login");
    const res = await middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/admin/dashboard");
  });

  it("not logged in → /login renders (no redirect)", async () => {
    getToken.mockResolvedValueOnce(null);
    const req = makeReq("https://example.com/login");
    const res = await middleware(req);
    expect(res.status).not.toBe(307);
  });
});

// ─── Admin-on-/dashboard guard ─────────────────────────────────────
describe("Admin-on-/dashboard guard — prevent role pollution of user surfaces", () => {
  it("admin on /dashboard → 307 to /admin/dashboard", async () => {
    getToken.mockResolvedValueOnce({ role: "admin" });
    const req = makeReq("https://example.com/dashboard");
    const res = await middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/admin/dashboard");
  });

  it("admin on /dashboard/hosting → 307 to /admin/dashboard", async () => {
    getToken.mockResolvedValueOnce({ role: "admin" });
    const req = makeReq("https://example.com/dashboard/hosting");
    const res = await middleware(req);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/admin/dashboard");
  });

  it("regular user on /dashboard → no redirect", async () => {
    getToken.mockResolvedValueOnce({ role: "user" });
    const req = makeReq("https://example.com/dashboard");
    const res = await middleware(req);
    expect(res.status).not.toBe(307);
  });
});

// ─── Protected route auth ───────────────────────────────────────────
describe("Protected user routes — auth gate", () => {
  it("no token on /dashboard → 307 to /login with returnUrl", async () => {
    getToken.mockResolvedValueOnce(null);
    const req = makeReq("https://example.com/dashboard");
    const res = await middleware(req);
    expect(res.status).toBe(307);
    const location = res.headers.get("location") || "";
    expect(location).toContain("/login");
    expect(location).toContain("returnUrl=%2Fdashboard");
  });

  it("no token on /checkout → 307 to /login with returnUrl", async () => {
    getToken.mockResolvedValueOnce(null);
    const req = makeReq("https://example.com/checkout");
    const res = await middleware(req);
    expect(res.status).toBe(307);
    const location = res.headers.get("location") || "";
    expect(location).toContain("/login");
    expect(location).toContain("returnUrl=%2Fcheckout");
  });

  it("**guest checkout (/checkout/guest) is PUBLIC** (no token required)", async () => {
    const req = makeReq("https://example.com/checkout/guest");
    await middleware(req);
    expect(getToken).not.toHaveBeenCalled();
  });
});

// ─── Public routes / public APIs ───────────────────────────────────
describe("Public routes / public APIs — no token fetch", () => {
  it.each([
    "/",
    "/about",
    "/contact",
    "/reset-password",
    "/complete-profile",
    "/activate",
    "/403",
  ])("public page %s does not fetch token", async (path) => {
    const req = makeReq(`https://example.com${path}`);
    await middleware(req);
    expect(getToken).not.toHaveBeenCalled();
  });

  it.each([
    "/api/auth/signin",
    "/api/webhooks/razorpay",
    "/api/health",
    "/api/status",
    "/api/log",
    "/api/chat",
    "/api/v1/chat",
    "/api/cart",
    "/api/v1/cart",
    "/api/domains/search",
    "/api/domains/tlds",
    "/api/check-ip",
    "/api/contact",
    "/api/cron/process-expiry",
    "/api/workers/sync-zoho-invoice",
    "/api/payments/guest/verify",
  ])("public API %s does not fetch token (CSRF-exempt)", async (path) => {
    const req = makeReq(`https://example.com${path}`, { method: "POST" });
    await middleware(req);
    expect(getToken).not.toHaveBeenCalled();
    expect(validateCSRF).not.toHaveBeenCalled();
  });
});

// ─── Authenticated non-admin API ───────────────────────────────────
describe("Authenticated non-admin /api/* — 401 JSON when no token", () => {
  it("no token on /api/user/settings GET → 401 JSON", async () => {
    getToken.mockResolvedValueOnce(null);
    const req = makeReq("https://example.com/api/user/settings");
    const res = await middleware(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });
});

// ─── CORS headers on API responses ──────────────────────────────────
describe("CORS headers — applied to all non-OPTIONS /api/* responses", () => {
  it("/api/* response gets addCorsHeaders called", async () => {
    getToken.mockResolvedValueOnce(null);
    const req = makeReq("https://example.com/api/health");
    await middleware(req);
    expect(addCorsHeaders).toHaveBeenCalled();
  });

  it("Non-API response does NOT get addCorsHeaders", async () => {
    const req = makeReq("https://example.com/");
    await middleware(req);
    expect(addCorsHeaders).not.toHaveBeenCalled();
  });
});

// ─── Request-id header ──────────────────────────────────────────────
describe("Request-ID propagation", () => {
  it("response carries x-request-id header (sourced from resolveRequestId)", async () => {
    resolveRequestId.mockReturnValueOnce("CUSTOM-RID-42");
    getToken.mockResolvedValueOnce(null);
    const req = makeReq("https://example.com/");
    const res = await middleware(req);
    expect(res.headers.get("x-request-id")).toBe("CUSTOM-RID-42");
  });
});
