/**
 * Tests for `@/lib/sms` (rescan-4 slice 7ds).
 * Provider-pluggable SMS abstraction. Pins:
 *  - Default provider is 'console' (logs only — no SMS credits burned)
 *  - SMS_PROVIDER='msg91' selects the MSG91 adapter
 *  - Phone numbers are masked in logs (last 4 digits only)
 *  - MSG91 requires AUTH_KEY + TEMPLATE_ID env (else error result, no fetch)
 *  - MSG91 happy path POSTs to /api/v5/flow with the auth header + 91-
 *    prefixed phone
 *  - MSG91 type='error' response surfaces as success:false
 *  - MSG91 network throw caught + surfaced as success:false
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const loggerInfo = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: loggerInfo, error: vi.fn(), warn: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  loggerInfo.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("sendSms — provider selection", () => {
  it("default provider is 'console' (no SMS_PROVIDER env set)", async () => {
    vi.stubEnv("SMS_PROVIDER", "");
    const { sendSms } = await import("@/lib/sms");
    const result = await sendSms({
      to: "9999911111",
      template: "trial_otp",
      variables: { code: "123456" },
    });
    expect(result.success).toBe(true);
    expect(result.provider).toBe("console");
    expect(result.messageId).toMatch(/^console_/);
    expect(loggerInfo).toHaveBeenCalledTimes(1);
  });

  it("phone is masked in the console log (only last 4 digits visible)", async () => {
    const { sendSms } = await import("@/lib/sms");
    await sendSms({
      to: "9999911111",
      template: "trial_otp",
      variables: { code: "000001" },
    });
    expect(loggerInfo.mock.calls[0][0]).toMatch(/\*\*\*1111/);
    // Full 10-digit number must NOT appear in the log line.
    expect(loggerInfo.mock.calls[0][0]).not.toContain("9999911111");
  });

  it("masks short numbers as '***' when fewer than 4 digits", async () => {
    const { sendSms } = await import("@/lib/sms");
    await sendSms({ to: "12", template: "trial_otp", variables: {} });
    expect(loggerInfo.mock.calls[0][0]).toMatch(/to=\*\*\*[^0-9]/);
  });

  it("SMS_PROVIDER='msg91' selects the MSG91 adapter", async () => {
    vi.stubEnv("SMS_PROVIDER", "msg91");
    vi.stubEnv("MSG91_AUTH_KEY", "test-key");
    vi.stubEnv("MSG91_TEMPLATE_ID", "tpl_abc");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ request_id: "req_42" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { sendSms } = await import("@/lib/sms");
    const result = await sendSms({
      to: "9999911111",
      template: "trial_otp",
      variables: { code: "123456" },
    });
    expect(result.success).toBe(true);
    expect(result.provider).toBe("msg91");
    expect(result.messageId).toBe("req_42");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("MSG91 provider", () => {
  beforeEach(() => {
    vi.stubEnv("SMS_PROVIDER", "msg91");
  });

  it("env validation: missing AUTH_KEY or TEMPLATE_ID → success:false + no fetch", async () => {
    vi.stubEnv("MSG91_AUTH_KEY", "");
    vi.stubEnv("MSG91_TEMPLATE_ID", "tpl_abc");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { sendSms } = await import("@/lib/sms");
    const result = await sendSms({
      to: "9999911111",
      template: "trial_otp",
      variables: {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalises 10-digit Indian numbers to 91-prefixed", async () => {
    vi.stubEnv("MSG91_AUTH_KEY", "key");
    vi.stubEnv("MSG91_TEMPLATE_ID", "tpl");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ request_id: "x" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { sendSms } = await import("@/lib/sms");
    await sendSms({ to: "9999911111", template: "trial_otp", variables: { code: "1" } });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.recipients[0].mobiles).toBe("919999911111");
  });

  it("forwards template variables as recipient fields", async () => {
    vi.stubEnv("MSG91_AUTH_KEY", "key");
    vi.stubEnv("MSG91_TEMPLATE_ID", "tpl-abc");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ request_id: "x" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { sendSms } = await import("@/lib/sms");
    await sendSms({
      to: "9999911111",
      template: "trial_otp",
      variables: { code: "123456", brand: "Anutech" },
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.template_id).toBe("tpl-abc");
    expect(body.recipients[0]).toMatchObject({
      mobiles: "919999911111",
      code: "123456",
      brand: "Anutech",
    });
  });

  it("uses 'authkey' header for authentication", async () => {
    vi.stubEnv("MSG91_AUTH_KEY", "the-key");
    vi.stubEnv("MSG91_TEMPLATE_ID", "tpl");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ request_id: "x" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { sendSms } = await import("@/lib/sms");
    await sendSms({ to: "9999911111", template: "trial_otp", variables: {} });
    expect(fetchMock.mock.calls[0][1].headers.authkey).toBe("the-key");
  });

  it("non-OK response → success:false with the server message", async () => {
    vi.stubEnv("MSG91_AUTH_KEY", "key");
    vi.stubEnv("MSG91_TEMPLATE_ID", "tpl");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ message: "Invalid auth key" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { sendSms } = await import("@/lib/sms");
    const result = await sendSms({
      to: "9999911111",
      template: "trial_otp",
      variables: {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("Invalid auth key");
  });

  it("MSG91 in-band error (type='error') → success:false", async () => {
    vi.stubEnv("MSG91_AUTH_KEY", "key");
    vi.stubEnv("MSG91_TEMPLATE_ID", "tpl");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ type: "error", message: "Template not approved" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { sendSms } = await import("@/lib/sms");
    const result = await sendSms({
      to: "9999911111",
      template: "trial_otp",
      variables: {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("Template not approved");
  });

  it("network throw caught + surfaced as success:false", async () => {
    vi.stubEnv("MSG91_AUTH_KEY", "key");
    vi.stubEnv("MSG91_TEMPLATE_ID", "tpl");
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);
    const { sendSms } = await import("@/lib/sms");
    const result = await sendSms({
      to: "9999911111",
      template: "trial_otp",
      variables: {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("ECONNREFUSED");
  });
});
