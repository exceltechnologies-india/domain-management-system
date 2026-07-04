/**
 * Tests for `@/lib/services/whatsapp-config` — the split-source config
 * resolver. Pins the operator-decided contract (2026-07-03):
 *   - Token is env-ONLY (never from DB settings)
 *   - Operational fields: DB setting → env → hardcoded default
 *   - Master enable flag defaults OFF
 *   - isWhatsAppConfigured = enabled && token && phoneNumberId
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getSettingsMap = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/settings", () => ({ getSettingsMap }));

import {
  getWhatsAppConfig,
  isWhatsAppConfigured,
  WHATSAPP_SETTING_KEYS,
} from "@/lib/services/whatsapp-config";

beforeEach(() => {
  getSettingsMap.mockReset().mockResolvedValue({});
  // Clean slate — no env by default; each test stubs what it needs.
  vi.stubEnv("WHATSAPP_API_TOKEN", "");
  vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "");
  vi.stubEnv("WHATSAPP_ENABLED", "");
  delete process.env.WHATSAPP_TEMPLATE_REMINDER;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("token is env-only", () => {
  it("reads token from env, never from DB settings", async () => {
    vi.stubEnv("WHATSAPP_API_TOKEN", "env-token");
    // Even if a DB setting tried to supply a token, it's ignored — there's
    // no settings key for the token by design.
    getSettingsMap.mockResolvedValue({ whatsapp_api_token: "db-token-should-be-ignored" });
    const config = await getWhatsAppConfig();
    expect(config.apiToken).toBe("env-token");
  });

  it("token absent → undefined (no DB fallback)", async () => {
    getSettingsMap.mockResolvedValue({ whatsapp_api_token: "db-token" });
    const config = await getWhatsAppConfig();
    expect(config.apiToken).toBeUndefined();
  });
});

describe("operational fields — DB-first, env-fallback", () => {
  it("phoneNumberId: DB setting wins over env", async () => {
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "env-phone");
    getSettingsMap.mockResolvedValue({
      [WHATSAPP_SETTING_KEYS.phoneNumberId]: "db-phone",
    });
    const config = await getWhatsAppConfig();
    expect(config.phoneNumberId).toBe("db-phone");
  });

  it("phoneNumberId: falls back to env when no DB setting", async () => {
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "env-phone");
    const config = await getWhatsAppConfig();
    expect(config.phoneNumberId).toBe("env-phone");
  });

  it("template names: DB → env → hardcoded default", async () => {
    // reminder from DB, payment from env, suspended from default
    vi.stubEnv("WHATSAPP_TEMPLATE_PAYMENT", "env_payment_tpl");
    getSettingsMap.mockResolvedValue({
      [WHATSAPP_SETTING_KEYS.templateReminder]: "db_reminder_tpl",
    });
    const config = await getWhatsAppConfig();
    expect(config.templates.reminder).toBe("db_reminder_tpl");
    expect(config.templates.payment).toBe("env_payment_tpl");
    expect(config.templates.suspended).toBe("service_suspended");
  });

  it("empty-string DB value is treated as unset (env fallback kicks in)", async () => {
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "env-phone");
    getSettingsMap.mockResolvedValue({ [WHATSAPP_SETTING_KEYS.phoneNumberId]: "  " });
    const config = await getWhatsAppConfig();
    expect(config.phoneNumberId).toBe("env-phone");
  });
});

describe("enable flag", () => {
  it("defaults OFF when neither DB nor env set", async () => {
    const config = await getWhatsAppConfig();
    expect(config.enabled).toBe(false);
  });

  it("DB boolean true → enabled", async () => {
    getSettingsMap.mockResolvedValue({ [WHATSAPP_SETTING_KEYS.enabled]: true });
    const config = await getWhatsAppConfig();
    expect(config.enabled).toBe(true);
  });

  it("DB string 'true' → enabled (coercion)", async () => {
    getSettingsMap.mockResolvedValue({ [WHATSAPP_SETTING_KEYS.enabled]: "true" });
    const config = await getWhatsAppConfig();
    expect(config.enabled).toBe(true);
  });

  it("DB false overrides env true (DB-first)", async () => {
    vi.stubEnv("WHATSAPP_ENABLED", "true");
    getSettingsMap.mockResolvedValue({ [WHATSAPP_SETTING_KEYS.enabled]: false });
    const config = await getWhatsAppConfig();
    expect(config.enabled).toBe(false);
  });

  it("env fallback when DB unset", async () => {
    vi.stubEnv("WHATSAPP_ENABLED", "1");
    const config = await getWhatsAppConfig();
    expect(config.enabled).toBe(true);
  });
});

describe("isWhatsAppConfigured — AND gate", () => {
  it("all present → true", async () => {
    vi.stubEnv("WHATSAPP_API_TOKEN", "t");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "p");
    vi.stubEnv("WHATSAPP_ENABLED", "true");
    expect(isWhatsAppConfigured(await getWhatsAppConfig())).toBe(true);
  });

  it("enabled but no token → false", async () => {
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "p");
    vi.stubEnv("WHATSAPP_ENABLED", "true");
    expect(isWhatsAppConfigured(await getWhatsAppConfig())).toBe(false);
  });

  it("token + phoneId but disabled → false", async () => {
    vi.stubEnv("WHATSAPP_API_TOKEN", "t");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "p");
    expect(isWhatsAppConfigured(await getWhatsAppConfig())).toBe(false);
  });
});
