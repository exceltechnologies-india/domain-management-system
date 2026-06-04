/**
 * Tests for `@/lib/zohobooks` (rescan-4 slice 7ft). Singleton service
 * class that owns Zoho auth state + base infra; topical submodules
 * (contacts/invoices/recurring/credit-notes/org) delegate. Pins:
 *  - **Singleton**: getInstance returns the SAME instance (auth state +
 *    token cache must persist across all callers)
 *  - **DC-based baseUrl routing**: env ZOHO_DC='.in' (default) →
 *    zohoapis.in; 'com' → zohoapis.com; 'eu' → zohoapis.eu; any other
 *    value falls back to zohoapis.in. Leading dot stripped before
 *    comparison. (The DC routes auth host too: zoho.com vs zoho.in/eu)
 *  - **_hasRefreshToken**: gates almost every public method; reads
 *    process.env.ZOHO_REFRESH_TOKEN at construction time (NOT live —
 *    so a runtime env-var flip won't take effect without restart)
 *  - **ZohoError shape**: name='ZohoError', title + code + details
 *    fields; message = "${title}: ${JSON.stringify(details)}"
 *  - **roundAmount**: 2-decimal rounding via Math.round(v*100)/100 —
 *    avoids floating-point noise being sent to Zoho
 *  - **isValidGst**: 15-char regex (2 state digits + 5 letters + 4
 *    digits + 1 letter + 1 digit-or-letter + 'Z' + 1 char), trims +
 *    strips spaces, uppercases before match
 *  - **getHeaders contract**: 'Zoho-oauthtoken ${token}' Authorization,
 *    Content-Type JSON, X-com-zoho-books-organizationid header ONLY
 *    when orgId set (scope to single org even though token may have
 *    access to many)
 *  - **defaultParams**: { organization_id } when orgId set; {} otherwise
 *  - **getAccessToken caching**: token cached until tokenExpiry, then
 *    refreshes; **60s safety buffer** subtracted from expiry (so we
 *    refresh BEFORE the token actually dies — anti-edge-of-cliff
 *    refresh that would otherwise hit a 401 in production)
 *  - **getAccessToken error**: wraps any failure in ZohoError 'AUTH_ERROR'
 *  - **idempotentRetry retry policy**: 3 attempts default; retryable
 *    iff status falsy OR status >= 500 OR status === 429; 4xx
 *    (validation/auth) NOT retried — throws immediately
 *  - **idempotentRetry exponential backoff**: delay * 2^i (1s → 2s → 4s)
 *  - **103001 detection**: sets _subscriptionExpired flag (once — guard
 *    prevents repeat DB writes) so health-check surfaces it without a
 *    write-level probe call
 *  - **ORG_STATE throws if env missing** (GST tax-type calc would
 *    silently mis-route without it — fail-loud at access time)
 *  - **roundAmount + isValidGst** exposed via _-prefixed accessors so
 *    submodules can share state without exposing them publicly
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Resettable axios mock — get/post for token refresh + API calls
vi.mock("axios", async () => {
  const post = vi.fn();
  return {
    default: { post },
    AxiosError: (await vi.importActual<typeof import("axios")>("axios"))
      .AxiosError,
  };
});

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/services/settings", () => ({
  upsertSetting: vi.fn(),
  deleteSetting: vi.fn(),
}));

import axios from "axios";
import { AxiosError } from "axios";
import { ZohoBooksService, ZohoError } from "@/lib/zohobooks";

const mockedPost = vi.mocked(axios.post);

function makeAxiosError(status: number, data: unknown) {
  return new AxiosError("Request failed", "ERR", undefined, undefined, {
    status,
    statusText: "Err",
    data,
    headers: {},
    config: {},
  } as any);
}

beforeEach(() => {
  mockedPost.mockReset();
  // Reset singleton between tests — direct field poke via cast
  (ZohoBooksService as any).instance = undefined;
  // Default env: .in DC, sane minimums
  vi.stubEnv("ZOHO_CLIENT_ID", "client-id");
  vi.stubEnv("ZOHO_CLIENT_SECRET", "client-secret");
  vi.stubEnv("ZOHO_REFRESH_TOKEN", "refresh-token");
  vi.stubEnv("ZOHO_ORG_ID", "ORG-1");
  vi.stubEnv("ZOHO_ORG_STATE", "Maharashtra");
  delete process.env.ZOHO_DC; // default to .in
  delete process.env.ZOHO_LOCATION_ID;
  delete process.env.ZOHO_TAX_ID_GST18;
  delete process.env.ZOHO_TAX_ID_IGST18;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── ZohoError class ───────────────────────────────────────────────
describe("ZohoError", () => {
  it("name + title + code + details fields exposed", () => {
    const err = new ZohoError("Boom", "BOOM", { reason: "x" });
    expect(err.name).toBe("ZohoError");
    expect(err.title).toBe("Boom");
    expect(err.code).toBe("BOOM");
    expect(err.details).toEqual({ reason: "x" });
  });

  it("message = `${title}: ${JSON.stringify(details)}`", () => {
    const err = new ZohoError("Auth Failed", "AUTH_ERROR", "invalid token");
    expect(err.message).toBe('Auth Failed: "invalid token"');
  });

  it("instanceof Error AND instanceof ZohoError", () => {
    const err = new ZohoError("X", "Y", null);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ZohoError);
  });
});

// ─── Singleton ─────────────────────────────────────────────────────
describe("Singleton", () => {
  it("getInstance returns the SAME instance across calls", () => {
    const a = ZohoBooksService.getInstance();
    const b = ZohoBooksService.getInstance();
    expect(a).toBe(b);
  });
});

// ─── DC-based baseUrl routing ─────────────────────────────────────
describe("DC-based baseUrl routing", () => {
  it("default (no ZOHO_DC) → zohoapis.in", () => {
    const svc = ZohoBooksService.getInstance();
    expect(svc._baseUrl).toBe("https://www.zohoapis.in/books/v3");
  });

  it("ZOHO_DC='.in' → zohoapis.in (leading dot stripped before compare)", () => {
    vi.stubEnv("ZOHO_DC", ".in");
    (ZohoBooksService as any).instance = undefined;
    const svc = ZohoBooksService.getInstance();
    expect(svc._baseUrl).toBe("https://www.zohoapis.in/books/v3");
  });

  it("ZOHO_DC='com' → zohoapis.com", () => {
    vi.stubEnv("ZOHO_DC", "com");
    (ZohoBooksService as any).instance = undefined;
    const svc = ZohoBooksService.getInstance();
    expect(svc._baseUrl).toBe("https://www.zohoapis.com/books/v3");
  });

  it("ZOHO_DC='eu' → zohoapis.eu", () => {
    vi.stubEnv("ZOHO_DC", "eu");
    (ZohoBooksService as any).instance = undefined;
    const svc = ZohoBooksService.getInstance();
    expect(svc._baseUrl).toBe("https://www.zohoapis.eu/books/v3");
  });

  it("unknown DC → falls back to zohoapis.in", () => {
    vi.stubEnv("ZOHO_DC", "xy");
    (ZohoBooksService as any).instance = undefined;
    const svc = ZohoBooksService.getInstance();
    expect(svc._baseUrl).toBe("https://www.zohoapis.in/books/v3");
  });
});

// ─── _hasRefreshToken ──────────────────────────────────────────────
describe("_hasRefreshToken", () => {
  it("present → true", () => {
    const svc = ZohoBooksService.getInstance();
    expect(svc._hasRefreshToken()).toBe(true);
  });

  it("empty env var at construction → false (NOT live; needs restart)", () => {
    vi.stubEnv("ZOHO_REFRESH_TOKEN", "");
    (ZohoBooksService as any).instance = undefined;
    const svc = ZohoBooksService.getInstance();
    expect(svc._hasRefreshToken()).toBe(false);
  });
});

// ─── _roundAmount ──────────────────────────────────────────────────
describe("_roundAmount — 2-decimal rounding", () => {
  it("rounds to 2 decimals via Math.round(v*100)/100", () => {
    const svc = ZohoBooksService.getInstance();
    expect(svc._roundAmount(1.234)).toBe(1.23);
    expect(svc._roundAmount(1.235)).toBe(1.24); // banker → up
    expect(svc._roundAmount(999.999)).toBe(1000);
    expect(svc._roundAmount(0)).toBe(0);
    expect(svc._roundAmount(0.001)).toBe(0);
  });

  it("integer input is identity", () => {
    const svc = ZohoBooksService.getInstance();
    expect(svc._roundAmount(100)).toBe(100);
  });
});

// ─── _isValidGst ───────────────────────────────────────────────────
describe("_isValidGst — 15-char Indian GSTIN regex", () => {
  it("valid GSTIN accepted", () => {
    const svc = ZohoBooksService.getInstance();
    expect(svc._isValidGst("27AABCU9603R1ZW")).toBe(true);
  });

  it("strips whitespace before validating", () => {
    const svc = ZohoBooksService.getInstance();
    expect(svc._isValidGst("  27AABCU9603R1ZW  ")).toBe(true);
    expect(svc._isValidGst("27 AABCU 9603R1ZW")).toBe(true);
  });

  it("uppercases before regex match (lowercase still valid)", () => {
    const svc = ZohoBooksService.getInstance();
    expect(svc._isValidGst("27aabcu9603r1zw")).toBe(true);
  });

  it("wrong length → false", () => {
    const svc = ZohoBooksService.getInstance();
    expect(svc._isValidGst("27AABCU9603R1Z")).toBe(false); // 14
    expect(svc._isValidGst("27AABCU9603R1ZWA")).toBe(false); // 16
  });

  it("empty / falsy → false", () => {
    const svc = ZohoBooksService.getInstance();
    expect(svc._isValidGst("")).toBe(false);
    expect(svc._isValidGst(null as any)).toBe(false);
  });

  it("structurally wrong (missing Z at position 13) → false", () => {
    const svc = ZohoBooksService.getInstance();
    expect(svc._isValidGst("27AABCU9603R1XW")).toBe(false); // Z missing
  });
});

// ─── _defaultParams ────────────────────────────────────────────────
describe("_defaultParams + _orgId", () => {
  it("orgId set → { organization_id }", () => {
    const svc = ZohoBooksService.getInstance();
    expect(svc._defaultParams).toEqual({ organization_id: "ORG-1" });
    expect(svc._orgId).toBe("ORG-1");
  });

  it("orgId absent → {}", () => {
    delete process.env.ZOHO_ORG_ID;
    (ZohoBooksService as any).instance = undefined;
    const svc = ZohoBooksService.getInstance();
    expect(svc._defaultParams).toEqual({});
    expect(svc._orgId).toBeUndefined();
  });
});

// ─── _LOCATION_ID / _TAX_IDS / _ORG_STATE ─────────────────────────
describe("_LOCATION_ID + _TAX_IDS + _ORG_STATE", () => {
  it("_LOCATION_ID env-override wins", () => {
    vi.stubEnv("ZOHO_LOCATION_ID", "LOC-OVERRIDE");
    const svc = ZohoBooksService.getInstance();
    expect(svc._LOCATION_ID).toBe("LOC-OVERRIDE");
  });

  it("_LOCATION_ID fallback when env absent", () => {
    delete process.env.ZOHO_LOCATION_ID;
    const svc = ZohoBooksService.getInstance();
    expect(svc._LOCATION_ID).toBe("3847734000000059031");
  });

  it("_ORG_STATE returns env", () => {
    const svc = ZohoBooksService.getInstance();
    expect(svc._ORG_STATE).toBe("Maharashtra");
  });

  it("_ORG_STATE THROWS when env missing (fail-loud — GST mis-route would be silent)", () => {
    delete process.env.ZOHO_ORG_STATE;
    const svc = ZohoBooksService.getInstance();
    expect(() => svc._ORG_STATE).toThrow(/ZOHO_ORG_STATE/);
  });

  it("_TAX_IDS: fallback IDs pinned (captured at class-load, NOT per-instance — env-override requires restart)", () => {
    const svc = ZohoBooksService.getInstance();
    // TAX_IDS is `private static readonly` evaluated at class-load time, so
    // setting env vars after the module is imported has no effect — what we
    // see now is whatever was in env when the test file's import ran.
    // The fallback values (when env was unset) are pinned here:
    expect(typeof svc._TAX_IDS.GST18).toBe("string");
    expect(typeof svc._TAX_IDS.IGST18).toBe("string");
    expect(svc._TAX_IDS.GST18.length).toBeGreaterThan(0);
    expect(svc._TAX_IDS.IGST18.length).toBeGreaterThan(0);
    expect(svc._TAX_IDS.GST18).not.toBe(svc._TAX_IDS.IGST18);
  });
});

// ─── getAccessToken / _getHeaders ─────────────────────────────────
describe("_getHeaders — bearer + content-type + org-scope header", () => {
  it("includes Zoho-oauthtoken Authorization + Content-Type JSON + X-com-zoho-books-organizationid", async () => {
    mockedPost.mockResolvedValueOnce({
      data: {
        access_token: "TOKEN-1",
        expires_in: 3600,
        api_domain: "https://www.zohoapis.in",
        token_type: "Bearer",
      },
    });
    const svc = ZohoBooksService.getInstance();
    const headers = await svc._getHeaders();
    expect(headers.Authorization).toBe("Zoho-oauthtoken TOKEN-1");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-com-zoho-books-organizationid"]).toBe("ORG-1");
  });

  it("orgId absent → no X-com-zoho-books-organizationid header", async () => {
    delete process.env.ZOHO_ORG_ID;
    (ZohoBooksService as any).instance = undefined;
    mockedPost.mockResolvedValueOnce({
      data: { access_token: "T", expires_in: 3600 },
    });
    const svc = ZohoBooksService.getInstance();
    const headers = await svc._getHeaders();
    expect(headers["X-com-zoho-books-organizationid"]).toBeUndefined();
  });

  it("token caching: second call within expiry-60s uses cached token (NO second POST)", async () => {
    mockedPost.mockResolvedValueOnce({
      data: { access_token: "TOKEN-1", expires_in: 3600 },
    });
    const svc = ZohoBooksService.getInstance();
    await svc._getHeaders();
    await svc._getHeaders();
    expect(mockedPost).toHaveBeenCalledTimes(1);
  });

  it("auth host routing: ZOHO_DC='com' → accounts.zoho.com (not .in)", async () => {
    vi.stubEnv("ZOHO_DC", "com");
    (ZohoBooksService as any).instance = undefined;
    mockedPost.mockResolvedValueOnce({
      data: { access_token: "T", expires_in: 3600 },
    });
    const svc = ZohoBooksService.getInstance();
    await svc._getHeaders();
    expect(mockedPost).toHaveBeenCalledWith(
      "https://accounts.zoho.com/oauth/v2/token",
      expect.any(URLSearchParams)
    );
  });

  it("auth host routing: default DC → accounts.zoho.in", async () => {
    mockedPost.mockResolvedValueOnce({
      data: { access_token: "T", expires_in: 3600 },
    });
    const svc = ZohoBooksService.getInstance();
    await svc._getHeaders();
    expect(mockedPost).toHaveBeenCalledWith(
      "https://accounts.zoho.in/oauth/v2/token",
      expect.any(URLSearchParams)
    );
  });

  it("OAuth error response → throws ZohoError AUTH_ERROR (response.data.error)", async () => {
    mockedPost.mockResolvedValueOnce({
      data: { error: "invalid_grant" } as any,
    });
    const svc = ZohoBooksService.getInstance();
    await expect(svc._getHeaders()).rejects.toMatchObject({
      name: "ZohoError",
      code: "AUTH_ERROR",
    });
  });

  it("network throw → ZohoError AUTH_ERROR (wraps anything)", async () => {
    mockedPost.mockRejectedValueOnce(new Error("ECONNRESET"));
    const svc = ZohoBooksService.getInstance();
    await expect(svc._getHeaders()).rejects.toMatchObject({
      name: "ZohoError",
      code: "AUTH_ERROR",
    });
  });

  it("token-refresh body sends refresh_token grant_type form", async () => {
    mockedPost.mockResolvedValueOnce({
      data: { access_token: "T", expires_in: 3600 },
    });
    const svc = ZohoBooksService.getInstance();
    await svc._getHeaders();
    const body = mockedPost.mock.calls[0][1] as URLSearchParams;
    expect(body.get("refresh_token")).toBe("refresh-token");
    expect(body.get("client_id")).toBe("client-id");
    expect(body.get("client_secret")).toBe("client-secret");
    expect(body.get("grant_type")).toBe("refresh_token");
  });
});

// ─── _idempotentRetry ──────────────────────────────────────────────
describe("_idempotentRetry — retry policy", () => {
  beforeEach(() => {
    // Speed up exponential backoff for retry tests
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("success on first try → no retry", async () => {
    const op = vi.fn().mockResolvedValueOnce("ok");
    const svc = ZohoBooksService.getInstance();
    await expect(svc._idempotentRetry(op)).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("network error (no status) → retried", async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce("ok");
    const svc = ZohoBooksService.getInstance();
    const p = svc._idempotentRetry(op);
    const expectation = expect(p).resolves.toBe("ok");
    await vi.runAllTimersAsync();
    await expectation;
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("5xx error → retried", async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(makeAxiosError(500, {}))
      .mockResolvedValueOnce("ok");
    const svc = ZohoBooksService.getInstance();
    const p = svc._idempotentRetry(op);
    const expectation = expect(p).resolves.toBe("ok");
    await vi.runAllTimersAsync();
    await expectation;
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("429 → retried", async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(makeAxiosError(429, {}))
      .mockResolvedValueOnce("ok");
    const svc = ZohoBooksService.getInstance();
    const p = svc._idempotentRetry(op);
    const expectation = expect(p).resolves.toBe("ok");
    await vi.runAllTimersAsync();
    await expectation;
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("400 (validation) → NOT retried — throws immediately", async () => {
    const op = vi.fn().mockRejectedValueOnce(makeAxiosError(400, { code: 5 }));
    const svc = ZohoBooksService.getInstance();
    await expect(svc._idempotentRetry(op)).rejects.toBeInstanceOf(AxiosError);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("401 (auth) → NOT retried", async () => {
    const op = vi.fn().mockRejectedValueOnce(makeAxiosError(401, {}));
    const svc = ZohoBooksService.getInstance();
    await expect(svc._idempotentRetry(op)).rejects.toBeInstanceOf(AxiosError);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("3-retry cap: 3 failed attempts → final lastError thrown", async () => {
    const op = vi.fn().mockRejectedValue(makeAxiosError(500, {}));
    const svc = ZohoBooksService.getInstance();
    const p = svc._idempotentRetry(op);
    const expectation = expect(p).rejects.toBeInstanceOf(AxiosError);
    await vi.runAllTimersAsync();
    await expectation;
    expect(op).toHaveBeenCalledTimes(3);
  });

  it("103001 sets _subscriptionExpired flag (then rethrows since 4xx not retried)", async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(makeAxiosError(403, { code: 103001 }));
    const svc = ZohoBooksService.getInstance();
    expect(svc.isSubscriptionExpired()).toBe(false);
    await expect(svc._idempotentRetry(op)).rejects.toBeInstanceOf(AxiosError);
    expect(svc.isSubscriptionExpired()).toBe(true);
  });
});

// ─── isSubscriptionExpired / clearSubscriptionExpiredInDB ─────────
describe("subscription-expired flag", () => {
  it("defaults to false on fresh instance", () => {
    const svc = ZohoBooksService.getInstance();
    expect(svc.isSubscriptionExpired()).toBe(false);
  });

  it("clearSubscriptionExpiredInDB resets the flag synchronously", () => {
    const svc = ZohoBooksService.getInstance();
    (svc as any)._subscriptionExpired = true;
    expect(svc.isSubscriptionExpired()).toBe(true);
    svc.clearSubscriptionExpiredInDB();
    expect(svc.isSubscriptionExpired()).toBe(false);
  });
});

// ─── Public method delegation surface ──────────────────────────────
describe("public methods preserve original signatures (smoke test of delegate shape)", () => {
  it("ZohoBooksService surface exposes all documented entry points", () => {
    const svc = ZohoBooksService.getInstance();
    const expected = [
      "getContactByEmail",
      "getContactByName",
      "createContact",
      "updateContactDetails",
      "getContactPersons",
      "updateContactPerson",
      "updateContactToConsumer",
      "createInvoice",
      "getInvoicesByEmail",
      "getInvoicePdf",
      "getAllInvoices",
      "createRecurringInvoice",
      "getInvoiceById",
      "applyPaymentToInvoice",
      "getInvoicesByReferenceNumber",
      "createCreditNote",
      "getOrganizationDetails",
    ];
    for (const name of expected) {
      expect(typeof (svc as any)[name]).toBe("function");
    }
  });

  it("internal accessors exposed for submodule sharing", () => {
    const svc = ZohoBooksService.getInstance();
    expect(typeof svc._hasRefreshToken).toBe("function");
    expect(typeof svc._getHeaders).toBe("function");
    expect(typeof svc._idempotentRetry).toBe("function");
    expect(typeof svc._isValidGst).toBe("function");
    expect(typeof svc._roundAmount).toBe("function");
    expect(typeof svc._baseUrl).toBe("string");
    // _orgId may be undefined when env absent
    expect(["string", "undefined"]).toContain(typeof svc._orgId);
  });
});
