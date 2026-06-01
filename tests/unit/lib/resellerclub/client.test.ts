/**
 * Tests for `@/lib/resellerclub/client` (rescan-4 slice 7dy).
 * Axios facade + interceptors for the ResellerClub API. Pins:
 *  - missing RESELLERCLUB_* env throws at module load
 *  - axios.create called with the right baseURL + timeout(30s) + UA header
 *  - request interceptor masks api-key + auth-userid before serverLogger,
 *    then APPENDS auth-userid / api-key / reseller-id to params
 *  - response success interceptor logs status + url
 *  - response error interceptor logs path-only (NEVER params) — that's
 *    the credential-leak guard
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const axiosCreateMock = vi.hoisted(() => vi.fn());
const reqInterceptorRegister = vi.hoisted(() => vi.fn());
const resInterceptorRegister = vi.hoisted(() => vi.fn());
vi.mock("axios", () => ({
  default: {
    create: axiosCreateMock,
  },
}));

const loggerInfo = vi.hoisted(() => vi.fn());
const loggerError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: loggerInfo, error: loggerError, warn: vi.fn() },
}));

const ORIG_ENV = {
  RESELLERCLUB_API_URL: process.env.RESELLERCLUB_API_URL,
  RESELLERCLUB_ID: process.env.RESELLERCLUB_ID,
  RESELLERCLUB_SECRET: process.env.RESELLERCLUB_SECRET,
};

beforeEach(() => {
  axiosCreateMock.mockReset();
  reqInterceptorRegister.mockReset();
  resInterceptorRegister.mockReset();
  loggerInfo.mockReset();
  loggerError.mockReset();
  axiosCreateMock.mockReturnValue({
    interceptors: {
      request: { use: reqInterceptorRegister },
      response: { use: resInterceptorRegister },
    },
  });
  vi.resetModules();
});

afterEach(() => {
  process.env.RESELLERCLUB_API_URL = ORIG_ENV.RESELLERCLUB_API_URL;
  process.env.RESELLERCLUB_ID = ORIG_ENV.RESELLERCLUB_ID;
  process.env.RESELLERCLUB_SECRET = ORIG_ENV.RESELLERCLUB_SECRET;
});

function setEnv() {
  process.env.RESELLERCLUB_API_URL = "https://test-httpapi.com/api/";
  process.env.RESELLERCLUB_ID = "RC_ID_42";
  process.env.RESELLERCLUB_SECRET = "RC_SECRET_xyz";
}

describe("module-load env validation", () => {
  it("throws when RESELLERCLUB_API_URL is missing", async () => {
    delete process.env.RESELLERCLUB_API_URL;
    process.env.RESELLERCLUB_ID = "id";
    process.env.RESELLERCLUB_SECRET = "secret";
    await expect(import("@/lib/resellerclub/client")).rejects.toThrow(
      /ResellerClub API configuration is missing/
    );
  });

  it("throws when RESELLERCLUB_ID is missing", async () => {
    process.env.RESELLERCLUB_API_URL = "url";
    delete process.env.RESELLERCLUB_ID;
    process.env.RESELLERCLUB_SECRET = "secret";
    await expect(import("@/lib/resellerclub/client")).rejects.toThrow(
      /ResellerClub API configuration is missing/
    );
  });

  it("throws when RESELLERCLUB_SECRET is missing", async () => {
    process.env.RESELLERCLUB_API_URL = "url";
    process.env.RESELLERCLUB_ID = "id";
    delete process.env.RESELLERCLUB_SECRET;
    await expect(import("@/lib/resellerclub/client")).rejects.toThrow(
      /ResellerClub API configuration is missing/
    );
  });
});

describe("axios.create configuration", () => {
  it("uses RESELLERCLUB_API_URL as baseURL + 30s timeout + UA header", async () => {
    setEnv();
    await import("@/lib/resellerclub/client");
    expect(axiosCreateMock).toHaveBeenCalledTimes(1);
    const [config] = axiosCreateMock.mock.calls[0];
    expect(config.baseURL).toBe("https://test-httpapi.com/api/");
    expect(config.timeout).toBe(30000);
    expect(config.headers["User-Agent"]).toMatch(/Mozilla/);
    expect(config.headers["Accept"]).toBe("application/json, text/plain, */*");
  });
});

describe("request interceptor", () => {
  it("masks api-key + auth-userid in logger, then INJECTS RC credentials into params", async () => {
    setEnv();
    await import("@/lib/resellerclub/client");
    const [reqOk] = reqInterceptorRegister.mock.calls[0];
    const config = {
      method: "post",
      url: "/domains/check.json",
      baseURL: "https://test-httpapi.com/api/",
      params: { "api-key": "WILL_BE_REPLACED", domain: "example.com" },
      data: undefined,
    };
    const out = reqOk(config);
    // The log call: api-key should be masked to "***".
    const logArgs = loggerInfo.mock.calls[0];
    expect(logArgs[0]).toMatch(/\[RC-REQUEST\] POST/);
    expect(logArgs[1].params["api-key"]).toBe("***");
    // The returned config gets credentials APPENDED — the masking was
    // only for the log, not for the wire.
    expect(out.params["auth-userid"]).toBe("RC_ID_42");
    expect(out.params["api-key"]).toBe("RC_SECRET_xyz");
    expect(out.params["reseller-id"]).toBe("RC_ID_42");
    expect(out.params.domain).toBe("example.com");
  });

  it("error path: logs [RC-REQ-ERROR] + rejects", async () => {
    setEnv();
    await import("@/lib/resellerclub/client");
    const [, reqErr] = reqInterceptorRegister.mock.calls[0];
    const err = new Error("network down");
    await expect(reqErr(err)).rejects.toBe(err);
    expect(loggerError).toHaveBeenCalledWith("[RC-REQ-ERROR]", err);
  });
});

describe("response interceptor", () => {
  it("success: logs [RC-RESPONSE] status + url + passes response through unchanged", async () => {
    setEnv();
    await import("@/lib/resellerclub/client");
    const [resOk] = resInterceptorRegister.mock.calls[0];
    const response = {
      status: 200,
      statusText: "OK",
      data: { ok: true },
      config: { url: "/domains/check.json" },
    };
    expect(resOk(response)).toBe(response);
    expect(loggerInfo).toHaveBeenCalledWith(
      "[RC-RESPONSE] 200 /domains/check.json",
      expect.objectContaining({ statusText: "OK", data: { ok: true } })
    );
  });

  it("error: logs PATH only (no params — credential-leak guard)", async () => {
    setEnv();
    await import("@/lib/resellerclub/client");
    const [, resErr] = resInterceptorRegister.mock.calls[0];
    const err = {
      message: "Request failed",
      response: { status: 503, statusText: "Bad Gateway", data: "unavailable" },
      config: {
        url: "/domains/check.json",
        params: { "api-key": "leaky_secret" }, // <-- MUST NOT reach the logger
      },
      code: "ERR_BAD_RESPONSE",
    };
    await expect(resErr(err)).rejects.toBe(err);
    expect(loggerError).toHaveBeenCalled();
    const [msg, meta] = loggerError.mock.calls[0];
    expect(msg).toBe("[RC-API-ERROR] Request failed");
    expect(meta).toEqual({
      status: 503,
      statusText: "Bad Gateway",
      path: "/domains/check.json",
      data: "unavailable",
      code: "ERR_BAD_RESPONSE",
    });
    // Cred-leak guard: serialised log meta must not contain the api-key value.
    expect(JSON.stringify(meta)).not.toContain("leaky_secret");
  });
});
