/**
 * Tests for `@/lib/api-response-wrapper` (rescan-4 slice 7dp).
 * Pins:
 *  - withSecurityHeaders delegates to addSecurityHeaders
 *  - secureJsonResponse builds NextResponse.json + applies headers
 *  - secureErrorResponse: 500-level in production masks the error to
 *    'An internal server error occurred'; 500 in dev keeps the real
 *    error; 503 keeps the real error EVEN in production (handled
 *    differently because 503 is operational); 4xx keeps the real error
 *    always; 400 with errorDetails embeds them in the body
 *  - secureErrorResponse logs at error (5xx) vs warn (<5xx)
 *  - withSecureHeaders HOF applies headers after the handler
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const addSecurityHeadersMock = vi.hoisted(() =>
  vi.fn((response: unknown) => response)
);
vi.mock("@/lib/security-headers", () => ({
  addSecurityHeaders: addSecurityHeadersMock,
}));

const loggerError = vi.hoisted(() => vi.fn());
const loggerWarn = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { error: loggerError, warn: loggerWarn, info: vi.fn() },
}));

// Stub NextResponse.json to return a known shape we can inspect.
const nextResponseJsonMock = vi.hoisted(() =>
  vi.fn((data: unknown, init?: { status?: number }) => ({
    __next: true,
    data,
    status: init?.status ?? 200,
    headers: new Map<string, string>(),
  }))
);
vi.mock("next/server", () => ({
  NextRequest: class {},
  NextResponse: {
    json: nextResponseJsonMock,
  },
}));

beforeEach(() => {
  vi.resetModules();
  addSecurityHeadersMock.mockReset();
  addSecurityHeadersMock.mockImplementation((r: unknown) => r);
  loggerError.mockReset();
  loggerWarn.mockReset();
  nextResponseJsonMock.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("withSecurityHeaders", () => {
  it("delegates to addSecurityHeaders", async () => {
    const { withSecurityHeaders } = await import("@/lib/api-response-wrapper");
    const resp = { __resp: true } as unknown as Parameters<typeof withSecurityHeaders>[0];
    withSecurityHeaders(resp);
    expect(addSecurityHeadersMock).toHaveBeenCalledWith(resp);
  });
});

describe("secureJsonResponse", () => {
  it("builds NextResponse.json with the data + status, then applies security headers", async () => {
    const { secureJsonResponse } = await import("@/lib/api-response-wrapper");
    secureJsonResponse({ ok: true }, 201);
    expect(nextResponseJsonMock).toHaveBeenCalledWith({ ok: true }, { status: 201 });
    expect(addSecurityHeadersMock).toHaveBeenCalledTimes(1);
  });

  it("defaults status to 200", async () => {
    const { secureJsonResponse } = await import("@/lib/api-response-wrapper");
    secureJsonResponse({ id: 1 });
    expect(nextResponseJsonMock).toHaveBeenCalledWith({ id: 1 }, { status: 200 });
  });
});

describe("secureErrorResponse — message masking", () => {
  it("500 in production → masks the real error to a generic message", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { secureErrorResponse } = await import("@/lib/api-response-wrapper");
    secureErrorResponse("db connection failed", 500, "DB_ERROR");
    const [body] = nextResponseJsonMock.mock.calls[0];
    expect((body as { error: string }).error).toBe("An internal server error occurred");
    expect((body as { code: string }).code).toBe("DB_ERROR");
  });

  it("500 in dev → keeps the real error message", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { secureErrorResponse } = await import("@/lib/api-response-wrapper");
    secureErrorResponse("db connection failed", 500, "DB_ERROR");
    const [body] = nextResponseJsonMock.mock.calls[0];
    expect((body as { error: string }).error).toBe("db connection failed");
  });

  it("503 in production → keeps the real error (operational status, not internal disclosure)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { secureErrorResponse } = await import("@/lib/api-response-wrapper");
    secureErrorResponse("Hosting Server is unreachable", 503, "DA_SERVER_DOWN");
    const [body] = nextResponseJsonMock.mock.calls[0];
    expect((body as { error: string }).error).toBe("Hosting Server is unreachable");
  });

  it("4xx error → keeps the real error in production (validation/auth messages aren't internal disclosure)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { secureErrorResponse } = await import("@/lib/api-response-wrapper");
    secureErrorResponse("Email already in use", 400, "DUPLICATE_EMAIL");
    const [body] = nextResponseJsonMock.mock.calls[0];
    expect((body as { error: string }).error).toBe("Email already in use");
  });

  it("400 with errorDetails embeds them in the body (other statuses do not)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { secureErrorResponse } = await import("@/lib/api-response-wrapper");
    secureErrorResponse("Validation failed", 400, "VALIDATION_ERROR", {
      field: "email",
      reason: "invalid format",
    });
    const [body400] = nextResponseJsonMock.mock.calls[0];
    expect((body400 as { details?: unknown }).details).toEqual({
      field: "email",
      reason: "invalid format",
    });

    // Same call with status=500 → details NOT included (security: never leak internals).
    nextResponseJsonMock.mockClear();
    secureErrorResponse("DB error", 500, "DB_ERROR", { sqlState: "08006" });
    const [body500] = nextResponseJsonMock.mock.calls[0];
    expect((body500 as { details?: unknown }).details).toBeUndefined();
  });

  it("emits 'timestamp' on every error body", async () => {
    const { secureErrorResponse } = await import("@/lib/api-response-wrapper");
    secureErrorResponse("any", 400);
    const [body] = nextResponseJsonMock.mock.calls[0];
    expect((body as { timestamp: string }).timestamp).toBeTypeOf("string");
  });

  it("code defaults to 'ERROR' when not supplied", async () => {
    const { secureErrorResponse } = await import("@/lib/api-response-wrapper");
    secureErrorResponse("oops", 400);
    const [body] = nextResponseJsonMock.mock.calls[0];
    expect((body as { code: string }).code).toBe("ERROR");
  });
});

describe("secureErrorResponse — logging", () => {
  it("logs at ERROR for 5xx statuses", async () => {
    const { secureErrorResponse } = await import("@/lib/api-response-wrapper");
    secureErrorResponse("boom", 500, "INTERNAL");
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it("logs at WARN for <5xx statuses", async () => {
    const { secureErrorResponse } = await import("@/lib/api-response-wrapper");
    secureErrorResponse("bad input", 400, "VALIDATION");
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(loggerError).not.toHaveBeenCalled();
  });
});

describe("withSecureHeaders HOF", () => {
  it("applies addSecurityHeaders AFTER the handler resolves", async () => {
    const { withSecureHeaders } = await import("@/lib/api-response-wrapper");
    const handler = vi.fn().mockResolvedValue({ __resp: "from-handler" } as unknown);
    const wrapped = withSecureHeaders(handler as never);
    await wrapped({ url: "/x" } as never);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(addSecurityHeadersMock).toHaveBeenCalledWith({ __resp: "from-handler" });
  });
});
