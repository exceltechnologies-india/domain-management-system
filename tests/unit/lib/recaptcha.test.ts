/**
 * Tests for `@/lib/recaptcha` server side (rescan-4 slice 7ed).
 * RecaptchaServer.verifyToken + isCaptchaEnabled. Pins:
 *  - isCaptchaEnabled DEFAULTS TO TRUE on any error (security NEVER
 *    silently degraded — a setting-table outage shouldn't disable
 *    captcha)
 *  - DB setting value is the truth source (true OR string 'true')
 *  - verifyToken honours the admin kill-switch BEFORE any other check
 *    (no secret-key warning, no token check, no network call)
 *  - missing/placeholder secret key → warn + return success:true
 *    (dev convenience — captcha-disabled deploys don't 500)
 *  - empty token OR literal 'captcha-disabled' → success:false
 *    (the second case is the explicit "we know it's bypassed" sentinel
 *    that the frontend sends when captcha is off)
 *  - calls Google's siteverify URL with secret+response+remoteip
 *  - !data.success → returns error + error-codes array
 *  - network throw → success:false (logged, no crash)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", fetchMock);

const getSettingValueMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/settings", () => ({
  getSettingValue: getSettingValueMock,
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

type RS = typeof import("@/lib/recaptcha").RecaptchaServer;
let RecaptchaServer: RS;

beforeEach(async () => {
  fetchMock.mockReset();
  getSettingValueMock.mockReset();
  vi.stubEnv("RECAPTCHA_SECRET_KEY", "real-secret-key");
  // Re-import so the static `secretKey` field is re-read post-stub.
  vi.resetModules();
  RecaptchaServer = (await import("@/lib/recaptcha")).RecaptchaServer;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isCaptchaEnabled", () => {
  it("returns true when the DB setting is === true", async () => {
    getSettingValueMock.mockResolvedValueOnce(true);
    expect(await RecaptchaServer.isCaptchaEnabled()).toBe(true);
  });

  it("returns true when the DB setting is === 'true' (string-form)", async () => {
    getSettingValueMock.mockResolvedValueOnce("true");
    expect(await RecaptchaServer.isCaptchaEnabled()).toBe(true);
  });

  it("returns false when the DB setting is false", async () => {
    getSettingValueMock.mockResolvedValueOnce(false);
    expect(await RecaptchaServer.isCaptchaEnabled()).toBe(false);
  });

  it("DEFAULTS TO TRUE on any error (security never silently degraded)", async () => {
    getSettingValueMock.mockRejectedValueOnce(new Error("db connection lost"));
    expect(await RecaptchaServer.isCaptchaEnabled()).toBe(true);
  });
});

describe("verifyToken", () => {
  it("admin kill-switch is checked BEFORE any other branch — disabled → success:true with no network call", async () => {
    getSettingValueMock.mockResolvedValueOnce(false);
    const result = await RecaptchaServer.verifyToken("token");
    expect(result).toEqual({ success: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("missing secret key (placeholder value) → warn + success:true (dev convenience)", async () => {
    vi.stubEnv("RECAPTCHA_SECRET_KEY", "your-recaptcha-secret-key");
    // Need a fresh import so the static secretKey is re-read.
    vi.resetModules();
    getSettingValueMock.mockResolvedValueOnce(true);
    const { RecaptchaServer: Re } = await import("@/lib/recaptcha");
    const result = await Re.verifyToken("token");
    expect(result).toEqual({ success: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("empty token → success:false (caller MUST send a token)", async () => {
    getSettingValueMock.mockResolvedValueOnce(true);
    const result = await RecaptchaServer.verifyToken("");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/required/i);
  });

  it("literal 'captcha-disabled' sentinel token → success:false (the explicit-bypass form)", async () => {
    getSettingValueMock.mockResolvedValueOnce(true);
    const result = await RecaptchaServer.verifyToken("captcha-disabled");
    expect(result.success).toBe(false);
  });

  it("calls Google's siteverify with secret + response + remoteip; returns success:true on data.success", async () => {
    getSettingValueMock.mockResolvedValueOnce(true);
    fetchMock.mockResolvedValueOnce({
      json: () => Promise.resolve({ success: true }),
    });
    const result = await RecaptchaServer.verifyToken("real-token", "1.2.3.4");
    expect(result).toEqual({ success: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://www.google.com/recaptcha/api/siteverify");
    expect(init.method).toBe("POST");
    const body = init.body as URLSearchParams;
    expect(body.get("secret")).toBe("real-secret-key");
    expect(body.get("response")).toBe("real-token");
    expect(body.get("remoteip")).toBe("1.2.3.4");
  });

  it("remoteip omitted when not supplied", async () => {
    getSettingValueMock.mockResolvedValueOnce(true);
    fetchMock.mockResolvedValueOnce({
      json: () => Promise.resolve({ success: true }),
    });
    await RecaptchaServer.verifyToken("real-token");
    const [, init] = fetchMock.mock.calls[0];
    const body = init.body as URLSearchParams;
    expect(body.has("remoteip")).toBe(false);
  });

  it("!data.success → returns error + error-codes array", async () => {
    getSettingValueMock.mockResolvedValueOnce(true);
    fetchMock.mockResolvedValueOnce({
      json: () =>
        Promise.resolve({
          success: false,
          "error-codes": ["missing-input-response", "timeout-or-duplicate"],
        }),
    });
    const result = await RecaptchaServer.verifyToken("real-token");
    expect(result.success).toBe(false);
    expect(result["error-codes"]).toEqual([
      "missing-input-response",
      "timeout-or-duplicate",
    ]);
  });

  it("network throw → success:false (logged, never crashes the caller)", async () => {
    getSettingValueMock.mockResolvedValueOnce(true);
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const result = await RecaptchaServer.verifyToken("real-token");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Failed to verify/i);
  });
});
