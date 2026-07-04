/**
 * Tests for `@/lib/whatsapp` (rescan-4 slice 7fp). WhatsApp Cloud API
 * (Meta) template-message sender. Pins:
 *  - **isConfigured: AND-gate** — both WHATSAPP_API_TOKEN and
 *    WHATSAPP_PHONE_NUMBER_ID must be set; missing either short-circuits
 *    sendTemplate to `return false` BEFORE the fetch (don't bother Meta
 *    with a half-config; don't blow up on undefined token in headers)
 *  - **formatNumber E.164**: 10-digit → '+91' + digits (India assumption);
 *    12-digit starting with 91 → '+' + digits as-is; arbitrary length →
 *    '+' + digits (no validation rejection — pass-through)
 *  - **Non-digit stripping**: spaces/dashes/parens collapsed via /\D/g
 *  - **Components shape**: empty bodyParams → components:[] (NOT an
 *    empty body component — Meta rejects that); non-empty → single
 *    body component with each param wrapped as {type:'text', text}
 *  - **15s AbortSignal.timeout** on fetch (worker hot path — a hung
 *    Graph slot must not stall the worker's Cloud Run slot)
 *  - **Bearer auth + content-type JSON** on every send
 *  - **res.ok=false → false**; res.ok=true → true
 *  - **Network error → false** (caught and logged, never re-thrown —
 *    notifications are best-effort)
 *  - **sendServiceReminder template fallback**: env WHATSAPP_TEMPLATE_
 *    REMINDER → 'service_renewal_reminder' default; renewUrl uses
 *    NEXTAUTH_URL + '/dashboard' (empty NEXTAUTH_URL → just '/dashboard')
 *  - **sendPaymentConfirmed**: amount formatted as `${currency} ${amount}`
 *    with default currency 'INR'
 *  - **sendServiceSuspended**: renewUrl + 3 body params (name, type,
 *    renewUrl) in order
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

// Mock the DB boundary of the config resolver — `getSettingsMap` returns
// {} so the resolver falls through to env vars, preserving the original
// env-driven test behavior. The real getWhatsAppConfig + WhatsAppService
// code paths still run (template fallback, enable gate, isConfigured).
vi.mock("@/lib/services/settings", () => ({
  getSettingsMap: vi.fn(async () => ({})),
}));

import { WhatsAppService } from "@/lib/whatsapp";

const TOKEN = "test-token";
const PHONE_ID = "PHONE-123";

beforeEach(() => {
  vi.stubEnv("WHATSAPP_API_TOKEN", TOKEN);
  vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", PHONE_ID);
  // Master enable flag — env fallback since getSettingsMap is mocked to {}.
  // Default is OFF, so tests must explicitly enable to exercise the send path.
  vi.stubEnv("WHATSAPP_ENABLED", "true");
  vi.stubEnv("NEXTAUTH_URL", "https://example.com");
  // NOTE: do NOT pre-stub WHATSAPP_TEMPLATE_* to "" — the source uses
  // `?? fallback`, which fires on null/undefined but NOT on "". Empty
  // string would defeat the default-template fallback.
  delete process.env.WHATSAPP_TEMPLATE_REMINDER;
  delete process.env.WHATSAPP_TEMPLATE_PAYMENT;
  delete process.env.WHATSAPP_TEMPLATE_SUSPENDED;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function mockFetch(status: number, body: unknown = {}) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

describe("isConfigured — AND gate over enabled + token + phoneNumberId", () => {
  it("all set → true", async () => {
    expect(await WhatsAppService.isConfigured()).toBe(true);
  });

  it("missing token → false", async () => {
    vi.stubEnv("WHATSAPP_API_TOKEN", "");
    expect(await WhatsAppService.isConfigured()).toBe(false);
  });

  it("missing phoneNumberId → false", async () => {
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "");
    expect(await WhatsAppService.isConfigured()).toBe(false);
  });

  it("disabled (WHATSAPP_ENABLED unset) → false even with token + phoneId", async () => {
    vi.stubEnv("WHATSAPP_ENABLED", "");
    expect(await WhatsAppService.isConfigured()).toBe(false);
  });
});

describe("formatNumber — E.164 with India default", () => {
  it("10 digits → '+91' prefix added", () => {
    expect(WhatsAppService.formatNumber("9876543210")).toBe("+919876543210");
  });

  it("12 digits starting with '91' → '+' prefix (already country-coded)", () => {
    expect(WhatsAppService.formatNumber("919876543210")).toBe("+919876543210");
  });

  it("strips non-digit chars (spaces / dashes / parens)", () => {
    expect(WhatsAppService.formatNumber("+91 98765-43210")).toBe(
      "+919876543210"
    );
    expect(WhatsAppService.formatNumber("(98765) 43210")).toBe("+919876543210");
  });

  it("arbitrary length → bare '+' prefix (no validation)", () => {
    expect(WhatsAppService.formatNumber("1234567")).toBe("+1234567");
  });
});

describe("sendTemplate — config gate + fetch shape", () => {
  it("not configured → returns false BEFORE any fetch", async () => {
    vi.stubEnv("WHATSAPP_API_TOKEN", "");
    const f = vi.spyOn(globalThis, "fetch");
    const r = await WhatsAppService.sendTemplate("9876543210", "tpl", []);
    expect(r).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("res.ok → returns true", async () => {
    const f = mockFetch(200);
    const r = await WhatsAppService.sendTemplate("9876543210", "tpl", []);
    expect(r).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("posts to graph.facebook.com with the phoneNumberId path segment", async () => {
    const f = mockFetch(200);
    await WhatsAppService.sendTemplate("9876543210", "tpl", []);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://graph.facebook.com/v18.0/${PHONE_ID}/messages`);
    expect(init.method).toBe("POST");
  });

  it("Bearer auth + Content-Type JSON headers", async () => {
    const f = mockFetch(200);
    await WhatsAppService.sendTemplate("9876543210", "tpl", []);
    const init = f.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("15s AbortSignal.timeout attached", async () => {
    const f = mockFetch(200);
    await WhatsAppService.sendTemplate("9876543210", "tpl", []);
    const init = f.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("empty bodyParams → components:[] (Meta rejects empty body component)", async () => {
    const f = mockFetch(200);
    await WhatsAppService.sendTemplate("9876543210", "tpl", []);
    const init = f.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.template.components).toEqual([]);
  });

  it("non-empty bodyParams → wrapped in {type:'body', parameters:[{type:'text',text}...]}", async () => {
    const f = mockFetch(200);
    await WhatsAppService.sendTemplate("9876543210", "tpl", ["A", "B"]);
    const init = f.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.template.components).toEqual([
      {
        type: "body",
        parameters: [
          { type: "text", text: "A" },
          { type: "text", text: "B" },
        ],
      },
    ]);
  });

  it("messaging_product:'whatsapp' + type:'template' + template.name + language.code default 'en'", async () => {
    const f = mockFetch(200);
    await WhatsAppService.sendTemplate("9876543210", "my_template", ["X"]);
    const body = JSON.parse(
      (f.mock.calls[0][1] as RequestInit).body as string
    );
    expect(body.messaging_product).toBe("whatsapp");
    expect(body.type).toBe("template");
    expect(body.template.name).toBe("my_template");
    expect(body.template.language.code).toBe("en");
  });

  it("languageCode override flows through", async () => {
    const f = mockFetch(200);
    await WhatsAppService.sendTemplate("9876543210", "my_template", [], "hi");
    const body = JSON.parse(
      (f.mock.calls[0][1] as RequestInit).body as string
    );
    expect(body.template.language.code).toBe("hi");
  });

  it("to: number is E.164 formatted before being sent", async () => {
    const f = mockFetch(200);
    await WhatsAppService.sendTemplate("9876543210", "tpl", []);
    const body = JSON.parse(
      (f.mock.calls[0][1] as RequestInit).body as string
    );
    expect(body.to).toBe("+919876543210");
  });

  it("non-2xx response → false (best-effort, swallowed)", async () => {
    mockFetch(400, { error: { message: "bad" } });
    const r = await WhatsAppService.sendTemplate("9876543210", "tpl", []);
    expect(r).toBe(false);
  });

  it("network throw → false (caught, NOT rethrown)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new Error("ECONNRESET")
    );
    const r = await WhatsAppService.sendTemplate("9876543210", "tpl", []);
    expect(r).toBe(false);
  });

  it("non-2xx with invalid-JSON body → still returns false (catch on .json())", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("not-json", { status: 500 })
    );
    const r = await WhatsAppService.sendTemplate("9876543210", "tpl", []);
    expect(r).toBe(false);
  });
});

describe("sendServiceReminder — 'service_renewal_reminder' template", () => {
  it("default template name when env var absent", async () => {
    delete process.env.WHATSAPP_TEMPLATE_REMINDER;
    const f = mockFetch(200);
    await WhatsAppService.sendServiceReminder("9876543210", {
      serviceName: "Hosting",
      daysRemaining: 3,
    });
    const body = JSON.parse(
      (f.mock.calls[0][1] as RequestInit).body as string
    );
    expect(body.template.name).toBe("service_renewal_reminder");
  });

  it("env var override flows through to template.name", async () => {
    vi.stubEnv("WHATSAPP_TEMPLATE_REMINDER", "custom_reminder_v2");
    const f = mockFetch(200);
    await WhatsAppService.sendServiceReminder("9876543210", {
      serviceName: "Hosting",
      daysRemaining: 3,
    });
    const body = JSON.parse(
      (f.mock.calls[0][1] as RequestInit).body as string
    );
    expect(body.template.name).toBe("custom_reminder_v2");
  });

  it("body params: [serviceName, String(daysRemaining), renewUrl]", async () => {
    const f = mockFetch(200);
    await WhatsAppService.sendServiceReminder("9876543210", {
      serviceName: "Hosting",
      daysRemaining: 3,
    });
    const body = JSON.parse(
      (f.mock.calls[0][1] as RequestInit).body as string
    );
    expect(body.template.components[0].parameters).toEqual([
      { type: "text", text: "Hosting" },
      { type: "text", text: "3" },
      { type: "text", text: "https://example.com/dashboard" },
    ]);
  });

  it("missing NEXTAUTH_URL → renewUrl is just '/dashboard'", async () => {
    vi.stubEnv("NEXTAUTH_URL", "");
    const f = mockFetch(200);
    await WhatsAppService.sendServiceReminder("9876543210", {
      serviceName: "Hosting",
      daysRemaining: 1,
    });
    const body = JSON.parse(
      (f.mock.calls[0][1] as RequestInit).body as string
    );
    const params = body.template.components[0].parameters;
    expect(params[2].text).toBe("/dashboard");
  });
});

describe("sendPaymentConfirmed — 'payment_confirmed' template", () => {
  it("default template name + default currency INR", async () => {
    const f = mockFetch(200);
    await WhatsAppService.sendPaymentConfirmed("9876543210", {
      amount: 999,
      serviceName: "Domain",
    });
    const body = JSON.parse(
      (f.mock.calls[0][1] as RequestInit).body as string
    );
    expect(body.template.name).toBe("payment_confirmed");
    expect(body.template.components[0].parameters).toEqual([
      { type: "text", text: "INR 999" },
      { type: "text", text: "Domain" },
    ]);
  });

  it("currency override flows through", async () => {
    const f = mockFetch(200);
    await WhatsAppService.sendPaymentConfirmed("9876543210", {
      amount: 12,
      currency: "USD",
      serviceName: "Hosting",
    });
    const body = JSON.parse(
      (f.mock.calls[0][1] as RequestInit).body as string
    );
    expect(body.template.components[0].parameters[0].text).toBe("USD 12");
  });
});

describe("sendServiceSuspended — 'service_suspended' template", () => {
  it("3 body params in order: serviceName, serviceType, renewUrl", async () => {
    const f = mockFetch(200);
    await WhatsAppService.sendServiceSuspended("9876543210", {
      serviceName: "example.com",
      serviceType: "Domain",
    });
    const body = JSON.parse(
      (f.mock.calls[0][1] as RequestInit).body as string
    );
    expect(body.template.name).toBe("service_suspended");
    expect(body.template.components[0].parameters).toEqual([
      { type: "text", text: "example.com" },
      { type: "text", text: "Domain" },
      { type: "text", text: "https://example.com/dashboard" },
    ]);
  });
});
