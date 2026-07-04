/**
 * Tests for the admin WhatsApp routes — the security-critical contract is
 * that the status endpoint NEVER returns the token value (only hasToken),
 * and both routes are admin-gated.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ AuthService: { getAdminFromRequest } }));

const getWhatsAppConfig = vi.hoisted(() => vi.fn());
const isWhatsAppConfigured = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/whatsapp-config", () => ({
  getWhatsAppConfig,
  isWhatsAppConfigured,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest } = await vi.importActual<typeof import("next/server")>("next/server");

import { GET } from "@/app/api/admin/whatsapp/status/route";

function makeReq() {
  return new NextRequest("https://example.com/api/admin/whatsapp/status", { method: "GET" });
}

const FULL_CONFIG = {
  enabled: true,
  apiToken: "SECRET-TOKEN-should-never-leak",
  phoneNumberId: "PHONE-123",
  businessNumber: "+919876543210",
  templates: { reminder: "r", payment: "p", suspended: "s" },
};

beforeEach(() => {
  getAdminFromRequest.mockReset().mockResolvedValue({ email: "admin@x.test", _id: "A1" });
  getWhatsAppConfig.mockReset().mockResolvedValue(FULL_CONFIG);
  isWhatsAppConfigured.mockReset().mockReturnValue(true);
});

describe("GET /api/admin/whatsapp/status", () => {
  it("non-admin → 401", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  it("**never returns the token value — only hasToken:true**", async () => {
    const res = await GET(makeReq());
    const body = await res.json();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("SECRET-TOKEN-should-never-leak");
    expect(body.status.hasToken).toBe(true);
    // The token field must not exist on the response at all.
    expect(body.status.apiToken).toBeUndefined();
    expect(body.status.token).toBeUndefined();
  });

  it("hasToken:false when token absent", async () => {
    getWhatsAppConfig.mockResolvedValueOnce({ ...FULL_CONFIG, apiToken: undefined });
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.status.hasToken).toBe(false);
  });

  it("surfaces enabled / phoneNumberId / businessNumber / templates / ready", async () => {
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.status.enabled).toBe(true);
    expect(body.status.phoneNumberId).toBe("PHONE-123");
    expect(body.status.businessNumber).toBe("+919876543210");
    expect(body.status.templates).toEqual({ reminder: "r", payment: "p", suspended: "s" });
    expect(body.status.ready).toBe(true);
  });
});
