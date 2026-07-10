/**
 * Tests for `app/api/user/hosting/sso/route.ts` (slice 7hk, part 1).
 * One-click login from the dashboard to the customer's DirectAdmin
 * control panel. Generates a one-time login URL and 302-redirects.
 *
 * Threat model:
 *  - **Cross-tenant SSO**: a customer must NOT be able to one-time-
 *    login into another customer's DA panel. Verified via
 *    case-insensitive email match against DA's getUserConfig.
 *  - **Locked-out customer SSO**: a suspended account should NOT
 *    be SSO-reachable (defence in depth — even if the customer
 *    sees the link, the route refuses).
 *
 * Pins:
 *  - Auth → 401 'Unauthorized' (browser → themed redirect; API →
 *    JSON)
 *  - `?username=` triggers ownership verification via
 *    DirectAdminService.getUserConfig — case-insensitive email
 *    match against user.email. If email matches → proceed; if
 *    `targetUsername === user.directAdminUsername` → proceed (the
 *    explicitly linked account always allowed). Otherwise → 403
 *    OWNERSHIP_VERIFICATION_FAILED.
 *  - getUserConfig throw on the verify path → 400 VERIFICATION_ERROR
 *  - No `?username` + no linked `user.directAdminUsername` → 404
 *    HOSTING_NOT_FOUND
 *  - **Suspension guard**: getUserConfig on the resolved username;
 *    suspended==='yes' → 403 ACCOUNT_SUSPENDED. Failure to check
 *    suspension is logged but NOT fatal (defensive — proceeds to
 *    the SSO URL gen).
 *  - getOneTimeLoginUrl returns the URL; route 302-redirects there.
 *  - **Browser-vs-API error split**: Accept header containing
 *    `text/html` → redirect to `/hosting/error?code=&message=` on
 *    the correct host (x-forwarded-host first, host fallback,
 *    'app.anutech.in' fallback; x-forwarded-proto first, 'https'
 *    fallback). Otherwise → JSON via secureErrorResponse.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const getUserConfig = vi.hoisted(() => vi.fn());
const getOneTimeLoginUrl = vi.hoisted(() => vi.fn());
vi.mock("@/lib/directadmin", () => ({
  DirectAdminService: { getUserConfig, getOneTimeLoginUrl },
}));

const listHostingsForUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hostings", () => ({ listHostingsForUser }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/user/hosting/sso/route";

function makeReq(qs = "", headers: Record<string, string> = {}) {
  const url = qs
    ? `https://example.com/api/user/hosting/sso?${qs}`
    : "https://example.com/api/user/hosting/sso";
  return new NextRequest(url, { method: "GET", headers });
}

const user = {
  _id: "U1",
  email: "alice@example.com",
  directAdminUsername: "alice_da",
};

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(user);
  getUserConfig.mockReset();
  getOneTimeLoginUrl.mockReset();
  listHostingsForUser.mockReset().mockResolvedValue([]);
});

describe("Auth gate (dual response)", () => {
  it("no user → 401 JSON for API client (default Accept)", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("AUTH_REQUIRED");
  });

  it("no user + Accept text/html → 302 redirect to /hosting/error", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq("", { accept: "text/html,*/*" }));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    const loc = res.headers.get("location")!;
    expect(loc).toContain("/hosting/error");
    expect(loc).toContain("code=AUTH_REQUIRED");
  });
});

describe("?username ownership verification (from OUR records, not DA email)", () => {
  it("targetUsername owned via a Hosting doc (Hosting.userId) → proceeds", async () => {
    listHostingsForUser.mockResolvedValueOnce([{ directAdminUsername: "alice_alt" }]);
    getUserConfig.mockResolvedValueOnce({ suspended: "no" }); // suspension check only
    getOneTimeLoginUrl.mockResolvedValueOnce("https://da.example.com/sso/login?token=abc");

    const res = await GET(makeReq("username=alice_alt"));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(getOneTimeLoginUrl).toHaveBeenCalledWith("alice_alt");
  });

  it("targetUsername === user.directAdminUsername → proceeds (owned via linked username)", async () => {
    listHostingsForUser.mockResolvedValueOnce([]); // not in Hosting docs, but linked
    getUserConfig.mockResolvedValueOnce({ suspended: "no" });
    getOneTimeLoginUrl.mockResolvedValueOnce("https://da/sso");

    const res = await GET(makeReq("username=alice_da"));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(getOneTimeLoginUrl).toHaveBeenCalledWith("alice_da");
  });

  it("CROSS-TENANT: targetUsername NOT owned in our records → 403; no DA-email match, no SSO URL", async () => {
    // Even if the other account shares the operator's contact email, it must
    // be rejected because it isn't linked to this user in our DB.
    listHostingsForUser.mockResolvedValueOnce([{ directAdminUsername: "alice_alt" }]);
    const res = await GET(makeReq("username=bob_da"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("OWNERSHIP_VERIFICATION_FAILED");
    expect(getOneTimeLoginUrl).not.toHaveBeenCalled();
    // getUserConfig must NOT be consulted to decide ownership.
    expect(getUserConfig).not.toHaveBeenCalled();
  });

  it("ownership lookup (listHostingsForUser) throws → 400 VERIFICATION_ERROR", async () => {
    listHostingsForUser.mockRejectedValueOnce(new Error("DB unreachable"));
    const res = await GET(makeReq("username=alice_alt"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VERIFICATION_ERROR");
    expect(getOneTimeLoginUrl).not.toHaveBeenCalled();
  });
});

describe("No-linked-account guard", () => {
  it("no ?username AND user.directAdminUsername absent → 404 HOSTING_NOT_FOUND", async () => {
    getUserFromRequest.mockResolvedValueOnce({
      _id: "U1",
      email: "alice@example.com",
      // no directAdminUsername
    });
    const res = await GET(makeReq());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("HOSTING_NOT_FOUND");
    expect(getOneTimeLoginUrl).not.toHaveBeenCalled();
  });
});

describe("Suspension guard", () => {
  it("daConfig.suspended === 'yes' → 403 ACCOUNT_SUSPENDED; NO SSO URL gen", async () => {
    getUserConfig.mockResolvedValueOnce({ suspended: "yes" });
    const res = await GET(makeReq());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("ACCOUNT_SUSPENDED");
    expect(getOneTimeLoginUrl).not.toHaveBeenCalled();
  });

  it("suspension check throw is SWALLOWED (defensive — still attempts SSO)", async () => {
    getUserConfig.mockRejectedValueOnce(new Error("DA blip"));
    getOneTimeLoginUrl.mockResolvedValueOnce("https://da/sso");

    const res = await GET(makeReq());
    // Redirected to the SSO URL despite the suspension-check failure
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toBe("https://da/sso");
  });
});

describe("Happy path — SSO redirect", () => {
  it("getOneTimeLoginUrl result → 302 redirect to that URL", async () => {
    getUserConfig.mockResolvedValueOnce({ suspended: "no" });
    getOneTimeLoginUrl.mockResolvedValueOnce(
      "https://da.example.com/login?one_time_url=xyz"
    );
    const res = await GET(makeReq());
    expect(res.headers.get("location")).toBe(
      "https://da.example.com/login?one_time_url=xyz"
    );
  });
});

describe("Browser-vs-API error split", () => {
  it("browser (Accept text/html) → redirect to /hosting/error with code+message query", async () => {
    getUserConfig.mockResolvedValueOnce({ suspended: "yes" });
    const res = await GET(
      makeReq("", {
        accept: "text/html,application/xhtml+xml",
        host: "app.anutech.in",
      })
    );
    expect(res.status).toBeGreaterThanOrEqual(300);
    const loc = res.headers.get("location")!;
    expect(loc).toContain("/hosting/error");
    expect(loc).toContain("code=ACCOUNT_SUSPENDED");
    expect(loc).toContain("message=");
  });

  it("uses x-forwarded-host + x-forwarded-proto when present (proxy-aware)", async () => {
    getUserConfig.mockResolvedValueOnce({ suspended: "yes" });
    const res = await GET(
      makeReq("", {
        accept: "text/html",
        "x-forwarded-host": "myapp.example.com",
        "x-forwarded-proto": "https",
      })
    );
    const loc = res.headers.get("location")!;
    expect(loc).toContain("https://myapp.example.com/hosting/error");
  });

  it("API client (no text/html Accept) → JSON error via secureErrorResponse", async () => {
    getUserConfig.mockResolvedValueOnce({ suspended: "yes" });
    const res = await GET(makeReq("", { accept: "application/json" }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("ACCOUNT_SUSPENDED");
  });
});

describe("Outer catch", () => {
  it("getOneTimeLoginUrl throw → 500 SSO_FAILED for API client", async () => {
    getUserConfig.mockResolvedValueOnce({ suspended: "no" });
    getOneTimeLoginUrl.mockRejectedValueOnce(
      new Error("DA SDK crash apk_LEAK_ME")
    );
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("SSO_FAILED");
    expect(body.error).toBe("Failed to initiate DirectAdmin session");
    expect(body.error).not.toContain("apk_LEAK_ME");
  });
});
