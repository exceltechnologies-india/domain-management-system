/**
 * Tests for the WhatsApp webhook (app/api/webhooks/whatsapp/route.ts).
 * Pins:
 *  - GET handshake: echoes hub.challenge iff verify_token matches
 *  - POST: rejects bad X-Hub-Signature-256; acks when app secret unset
 *  - POST: inbound STOP → setWhatsAppOptOut(true); START → (false)
 *  - POST: status events don't crash + are acked 200
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "crypto";

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const setWhatsAppOptOut = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/whatsapp-optout", async (orig) => {
  const actual = await orig<typeof import("@/lib/services/whatsapp-optout")>();
  return { ...actual, setWhatsAppOptOut }; // keep real classifyOptKeyword
});

vi.unmock("next/server");
const { NextRequest } = await vi.importActual<typeof import("next/server")>("next/server");

import { GET, POST } from "@/app/api/webhooks/whatsapp/route";

const APP_SECRET = "test-app-secret";
const VERIFY_TOKEN = "my-verify-token";

function sign(body: string): string {
  return "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(body).digest("hex");
}

function makePost(body: object, sig?: string) {
  const raw = JSON.stringify(body);
  return new NextRequest("https://example.com/api/webhooks/whatsapp", {
    method: "POST",
    headers: { "x-hub-signature-256": sig ?? sign(raw), "content-type": "application/json" },
    body: raw,
  });
}

function makeGet(params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  return new NextRequest(`https://example.com/api/webhooks/whatsapp?${qs}`, { method: "GET" });
}

beforeEach(() => {
  setWhatsAppOptOut.mockReset().mockResolvedValue(1);
  vi.stubEnv("WHATSAPP_APP_SECRET", APP_SECRET);
  vi.stubEnv("WHATSAPP_WEBHOOK_VERIFY_TOKEN", VERIFY_TOKEN);
});
afterEach(() => vi.unstubAllEnvs());

describe("GET — verification handshake", () => {
  it("matching verify_token → echoes challenge, 200", async () => {
    const res = await GET(makeGet({ "hub.mode": "subscribe", "hub.verify_token": VERIFY_TOKEN, "hub.challenge": "CHALLENGE123" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("CHALLENGE123");
  });

  it("wrong verify_token → 403", async () => {
    const res = await GET(makeGet({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "X" }));
    expect(res.status).toBe(403);
  });
});

describe("POST — signature verification", () => {
  it("invalid signature → 401, no processing", async () => {
    const res = await POST(makePost({ entry: [] }, "sha256=deadbeef"));
    expect(res.status).toBe(401);
    expect(setWhatsAppOptOut).not.toHaveBeenCalled();
  });

  it("app secret unset → 200 ack, no processing (unconfigured)", async () => {
    vi.stubEnv("WHATSAPP_APP_SECRET", "");
    const res = await POST(makePost({ entry: [] }, "sha256=whatever"));
    expect(res.status).toBe(200);
    expect(setWhatsAppOptOut).not.toHaveBeenCalled();
  });

  it("valid signature → 200", async () => {
    const res = await POST(makePost({ entry: [] }));
    expect(res.status).toBe(200);
  });
});

describe("POST — inbound STOP / START", () => {
  function inbound(text: string) {
    return {
      entry: [{ changes: [{ value: { messages: [{ from: "919876543210", type: "text", text: { body: text } }] } }] }],
    };
  }

  it("STOP → setWhatsAppOptOut(from, true)", async () => {
    await POST(makePost(inbound("STOP")));
    expect(setWhatsAppOptOut).toHaveBeenCalledWith("919876543210", true);
  });

  it("case-insensitive 'stop' → opt-out", async () => {
    await POST(makePost(inbound("  Stop  ")));
    expect(setWhatsAppOptOut).toHaveBeenCalledWith("919876543210", true);
  });

  it("START → setWhatsAppOptOut(from, false)", async () => {
    await POST(makePost(inbound("START")));
    expect(setWhatsAppOptOut).toHaveBeenCalledWith("919876543210", false);
  });

  it("non-keyword reply → no opt-out call", async () => {
    await POST(makePost(inbound("hey when does my plan expire?")));
    expect(setWhatsAppOptOut).not.toHaveBeenCalled();
  });
});

describe("POST — status events", () => {
  it("delivery status batch → acked 200, no opt-out call", async () => {
    const body = {
      entry: [{ changes: [{ value: { statuses: [{ id: "wamid.1", status: "delivered", recipient_id: "919876543210" }] } }] }],
    };
    const res = await POST(makePost(body));
    expect(res.status).toBe(200);
    expect(setWhatsAppOptOut).not.toHaveBeenCalled();
  });
});
