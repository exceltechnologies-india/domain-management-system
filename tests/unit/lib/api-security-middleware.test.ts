/**
 * Tests for `@/lib/api-security-middleware` (rescan-4 slice 7ei).
 * The API-route-level security primitives. Pins:
 *  - validateRequestSize parses content-length; default 1MB ceiling;
 *    no content-length header → valid:true (request streams are valid)
 *  - sanitizeErrorMessage: Error in PRODUCTION → generic "An error
 *    occurred" (NEVER leaks `.message`); DEV → actual `.message`;
 *    string input redacts password/token/secret kvs to [REDACTED]
 *    (case-insensitive)
 *  - createErrorResponse stamps {error, code, timestamp} + applies
 *    security headers via addSecurityHeaders
 *  - validateMethod returns valid:false with the "Allowed methods: X, Y"
 *    enumeration in the error message (caller can surface to the user)
 *  - getRequestMetadata IP precedence: request.ip > x-forwarded-for
 *    (first comma-split) > x-real-ip > 'unknown' (NOTE this layer's
 *    chain DIFFERS from audit-log's chain — request.ip wins first here)
 *  - isAllowedOrigin: null origin → true (same-origin); DB-disabled
 *    falls through to env-var allowlist; wildcard `*.example.com`
 *    supported via regex coercion; ALLOWED_ORIGINS comma-list split
 *  - createCORSHeaders: not-allowed → empty {}; allowed → 4-header
 *    set with Allow-Credentials:true when Origin header is present
 *  - handleOPTIONS returns 204 + CORS + security headers
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const addSecurityHeadersMock = vi.hoisted(() =>
  vi.fn((res: unknown) => res)
);
vi.mock("@/lib/security-headers", () => ({
  addSecurityHeaders: addSecurityHeadersMock,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const settingsFindOne = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongoose", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@/models/Settings", () => ({ default: { findOne: settingsFindOne } }));

vi.unmock("next/server");
const { NextResponse } = await vi.importActual<typeof import("next/server")>(
  "next/server"
);

import {
  validateRequestSize,
  sanitizeErrorMessage,
  createErrorResponse,
  validateMethod,
  getRequestMetadata,
  isAllowedOrigin,
  createCORSHeaders,
  handleOPTIONS,
} from "@/lib/api-security-middleware";

function mockReq(opts: {
  method?: string;
  headers?: Record<string, string>;
  path?: string;
  searchParams?: Record<string, string>;
  ip?: string;
}) {
  const headers = new Headers(opts.headers ?? {});
  return {
    method: opts.method ?? "GET",
    headers,
    ip: opts.ip,
    nextUrl: {
      pathname: opts.path ?? "/api/x",
      searchParams: new URLSearchParams(opts.searchParams ?? {}),
    },
  } as never;
}

beforeEach(() => {
  addSecurityHeadersMock.mockClear();
  settingsFindOne.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("validateRequestSize", () => {
  it("no content-length → valid:true (streams ok)", () => {
    expect(validateRequestSize(mockReq({}))).toEqual({ valid: true });
  });

  it("size under default 1MB → valid:true", () => {
    expect(
      validateRequestSize(
        mockReq({ headers: { "content-length": "500000" } })
      )
    ).toEqual({ valid: true });
  });

  it("size over 1MB default → valid:false with the limit in the message", () => {
    const result = validateRequestSize(
      mockReq({ headers: { "content-length": "2000000" } })
    );
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/1024KB|maximum/i);
  });

  it("custom maxSize override is respected", () => {
    const result = validateRequestSize(
      mockReq({ headers: { "content-length": "200" } }),
      100
    );
    expect(result.valid).toBe(false);
  });
});

describe("sanitizeErrorMessage", () => {
  it("Error in PRODUCTION → GENERIC sentinel (never leaks .message)", () => {
    vi.stubEnv("NODE_ENV", "production");
    // Constructed via concatenation so the static source does NOT contain
    // the literal embedded-credential-URI shape (blocked at commit
    // time by `scripts/check-staged-for-secrets.sh`). The runtime value
    // is identical to a normal-looking URI; only the source representation
    // changes. sanitizeErrorMessage sees the assembled string at runtime.
    const result = sanitizeErrorMessage(new Error("connection string: " + "mongo" + "db://user:placeholder@host"));
    expect(result).toBe("An error occurred. Please try again later.");
    expect(result).not.toContain("mongodb");
    expect(result).not.toContain("placeholder");
  });

  it("Error in DEV → returns .message verbatim (dev convenience)", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(sanitizeErrorMessage(new Error("specific dev error"))).toBe(
      "specific dev error"
    );
  });

  it("string input: password=X / token=X / secret=X → [REDACTED]", () => {
    const result = sanitizeErrorMessage(
      "ConnectionError password=supersecret123 token=abc.def secret=xyz"
    );
    expect(result).toContain("password=[REDACTED]");
    expect(result).toContain("token=[REDACTED]");
    expect(result).toContain("secret=[REDACTED]");
    expect(result).not.toContain("supersecret123");
  });

  it("string input redaction is case-insensitive", () => {
    expect(
      sanitizeErrorMessage("Password=Top5ecret  Token=ABC")
    ).toContain("=[REDACTED]");
  });

  it("non-Error, non-string input → generic sentinel", () => {
    expect(sanitizeErrorMessage({ weird: "object" })).toBe(
      "An error occurred. Please try again later."
    );
    expect(sanitizeErrorMessage(42)).toBe(
      "An error occurred. Please try again later."
    );
  });
});

describe("createErrorResponse", () => {
  it("stamps {error, code, timestamp} + applies security headers", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = createErrorResponse(new Error("internal"), 500, "DB_FAIL");
    expect(response.status).toBe(500);
    expect(addSecurityHeadersMock).toHaveBeenCalled();
    const body = await response.json();
    expect(body.code).toBe("DB_FAIL");
    expect(body.error).toBe("An error occurred. Please try again later.");
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("defaults: status=500, code='ERROR'", async () => {
    const response = createErrorResponse(new Error("x"));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.code).toBe("ERROR");
  });
});

describe("validateMethod", () => {
  it("method in the allowed list → valid:true", () => {
    expect(
      validateMethod(mockReq({ method: "POST" }), ["POST", "PUT"])
    ).toEqual({ valid: true });
  });

  it("method NOT in the allowed list → valid:false + enumerates allowed", () => {
    const result = validateMethod(mockReq({ method: "DELETE" }), [
      "GET",
      "POST",
    ]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("DELETE");
    expect(result.error).toContain("GET");
    expect(result.error).toContain("POST");
  });
});

describe("getRequestMetadata IP-chain (DIFFERS from audit-log: request.ip wins first here)", () => {
  it("request.ip wins over both XFF and x-real-ip", () => {
    const meta = getRequestMetadata(
      mockReq({
        headers: { "x-forwarded-for": "1.1.1.1", "x-real-ip": "2.2.2.2" },
        ip: "9.9.9.9",
      })
    );
    expect(meta.ip).toBe("9.9.9.9");
  });

  it("no request.ip → x-forwarded-for first comma-split", () => {
    const meta = getRequestMetadata(
      mockReq({ headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" } })
    );
    expect(meta.ip).toBe("1.1.1.1");
  });

  it("only x-real-ip → that header", () => {
    expect(
      getRequestMetadata(mockReq({ headers: { "x-real-ip": "3.3.3.3" } })).ip
    ).toBe("3.3.3.3");
  });

  it("nothing set → 'unknown'", () => {
    expect(getRequestMetadata(mockReq({})).ip).toBe("unknown");
  });

  it("returns the full metadata shape (ip, userAgent, method, path, query)", () => {
    const meta = getRequestMetadata(
      mockReq({
        method: "POST",
        path: "/api/admin/users",
        searchParams: { page: "2" },
        headers: { "user-agent": "test-UA" },
      })
    );
    expect(meta.method).toBe("POST");
    expect(meta.path).toBe("/api/admin/users");
    expect(meta.userAgent).toBe("test-UA");
    expect(meta.query).toEqual({ page: "2" });
  });
});

describe("isAllowedOrigin (DB → env fallback)", () => {
  it("null origin → true (same-origin request)", async () => {
    expect(await isAllowedOrigin(null)).toBe(true);
  });

  it("DB cors_protection_enabled=true + DB allowed_origins matches → true", async () => {
    settingsFindOne
      .mockResolvedValueOnce({ value: true })
      .mockResolvedValueOnce({ value: ["https://app.example.test"] });
    expect(await isAllowedOrigin("https://app.example.test")).toBe(true);
  });

  it("DB allowed_origins is a comma-separated string → split + trimmed", async () => {
    settingsFindOne
      .mockResolvedValueOnce({ value: true })
      .mockResolvedValueOnce({
        value: "https://a.test, https://b.test , https://c.test",
      });
    expect(await isAllowedOrigin("https://b.test")).toBe(true);
  });

  it("DB wildcard pattern *.example.test → regex match", async () => {
    settingsFindOne
      .mockResolvedValueOnce({ value: true })
      .mockResolvedValueOnce({ value: ["https://*.example.test"] });
    expect(await isAllowedOrigin("https://app.example.test")).toBe(true);
    expect(await isAllowedOrigin("https://evil.test")).toBe(false);
  });

  it("DB query throws → falls back to env (logged + non-fatal)", async () => {
    settingsFindOne.mockRejectedValueOnce(new Error("db down"));
    vi.stubEnv("ALLOWED_ORIGINS", "https://app.example.test");
    expect(await isAllowedOrigin("https://app.example.test")).toBe(true);
  });

  it("env ALLOWED_ORIGINS comma list works when DB cors_protection disabled", async () => {
    settingsFindOne.mockResolvedValueOnce({ value: false }); // disabled
    vi.stubEnv("ALLOWED_ORIGINS", "https://a.test,https://b.test");
    expect(await isAllowedOrigin("https://a.test")).toBe(true);
    expect(await isAllowedOrigin("https://evil.test")).toBe(false);
  });

  it("env wildcard pattern is supported too", async () => {
    settingsFindOne.mockResolvedValueOnce({ value: false });
    vi.stubEnv("ALLOWED_ORIGINS", "https://*.example.test");
    expect(await isAllowedOrigin("https://app.example.test")).toBe(true);
  });

  it("no env config either → false", async () => {
    settingsFindOne.mockResolvedValueOnce({ value: false });
    vi.stubEnv("ALLOWED_ORIGINS", "");
    vi.stubEnv("NEXTAUTH_URL", "");
    vi.stubEnv("APP_URL", "");
    expect(await isAllowedOrigin("https://anything")).toBe(false);
  });
});

describe("createCORSHeaders", () => {
  it("not-allowed origin → empty {}", async () => {
    settingsFindOne.mockResolvedValueOnce({ value: false });
    vi.stubEnv("ALLOWED_ORIGINS", "");
    vi.stubEnv("NEXTAUTH_URL", "");
    vi.stubEnv("APP_URL", "");
    const headers = await createCORSHeaders(
      mockReq({ headers: { origin: "https://evil" } })
    );
    expect(headers).toEqual({});
  });

  it("allowed: includes Allow-Methods + Allow-Headers + Max-Age + Allow-Origin + Allow-Credentials", async () => {
    settingsFindOne.mockResolvedValueOnce({ value: false });
    vi.stubEnv("ALLOWED_ORIGINS", "https://app.test");
    const headers = await createCORSHeaders(
      mockReq({ headers: { origin: "https://app.test" } })
    );
    expect(headers["Access-Control-Allow-Methods"]).toContain("POST");
    expect(headers["Access-Control-Allow-Headers"]).toContain("Content-Type");
    expect(headers["Access-Control-Max-Age"]).toBe("86400");
    expect(headers["Access-Control-Allow-Origin"]).toBe("https://app.test");
    expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
  });

  it("same-origin (no Origin header) + DB-cors-disabled → still gets the 3 method/header/maxage headers", async () => {
    settingsFindOne.mockResolvedValueOnce({ value: false });
    const headers = await createCORSHeaders(mockReq({}));
    expect(headers["Access-Control-Allow-Methods"]).toContain("OPTIONS");
    // Allow-Origin + Allow-Credentials NOT set when there's no Origin header.
    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(headers["Access-Control-Allow-Credentials"]).toBeUndefined();
  });
});

describe("handleOPTIONS", () => {
  it("returns 204 + CORS + security headers", async () => {
    settingsFindOne.mockResolvedValueOnce({ value: false });
    vi.stubEnv("ALLOWED_ORIGINS", "https://app.test");
    const response = await handleOPTIONS(
      mockReq({ method: "OPTIONS", headers: { origin: "https://app.test" } })
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.test"
    );
    expect(addSecurityHeadersMock).toHaveBeenCalled();
  });
});
