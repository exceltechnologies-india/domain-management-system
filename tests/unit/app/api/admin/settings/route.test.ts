/**
 * Tests for `app/api/admin/settings/route.ts` (slice 7hy, part 1).
 *
 * Admin global-settings dashboard (read + write).
 *
 * Threat model — THE BIG ONE:
 *  - **Body-supplied `category` bypass of step-up auth**: a hostile
 *    admin (or one with a stolen session) could update a security-
 *    sensitive key (`2fa_required`, `directadmin_api_key`, etc.)
 *    while labelling the request body as `category: "general"` to
 *    skip the password challenge. The route's `isSecurityScopedKey`
 *    helper checks (a) a hardcoded SECURITY_KEYS allowlist, AND
 *    (b) the SERVER-STORED category of the existing setting —
 *    NEVER the body-supplied `category` field. Pinned with a
 *    direct hostile probe.
 *
 * Other threat model:
 *  - **Step-up cookie-only bypass**: requireReAuth must run BEFORE
 *    upsertSetting fires. Pinned: failed reauth → 403 + no
 *    upsertSetting call.
 *
 * Other pins:
 *  - GET: admin gate → 401; listSettings → reduce to key-value
 *    object; response shape locked
 *  - POST zod: key 1-100, value !== undefined required, description
 *    max:500, category max:100
 *  - Hardcoded SECURITY_KEYS (covers settings that may not exist
 *    on the server yet — first-time writes still trigger reauth)
 *  - Stored category='security' also triggers reauth even if key
 *    not in the allowlist
 *  - Non-security keys → no reauth required
 *  - Defaults: description ?? "", category ?? "general"
 *  - Post-write re-read to return canonical setting
 *  - Outer catch → 500 generic
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const requireReAuth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/admin-security", () => ({ requireReAuth }));

const listSettings = vi.hoisted(() => vi.fn());
const upsertSetting = vi.hoisted(() => vi.fn());
const getSetting = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/settings", () => ({
  listSettings,
  upsertSetting,
  getSetting,
}));

vi.mock("@/lib/mongoose", () => ({
  connectToDatabase: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET, POST } from "@/app/api/admin/settings/route";

function makeReq(method: "GET" | "POST", body?: unknown) {
  return new NextRequest("https://example.com/api/admin/settings", {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const ADMIN = { _id: "ADMIN1", email: "admin@example.com" };

beforeEach(() => {
  getAdminFromRequest.mockReset().mockResolvedValue(ADMIN);
  requireReAuth.mockReset().mockResolvedValue({ passed: true });
  listSettings.mockReset();
  upsertSetting.mockReset().mockResolvedValue(undefined);
  getSetting.mockReset();
});

// ─────────────────────────── GET ─────────────────────────────

describe("GET — admin gate", () => {
  it("non-admin → 401; no DB read", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(401);
    expect(listSettings).not.toHaveBeenCalled();
  });
});

describe("GET — list shape", () => {
  it("settings list reduces to key-value object", async () => {
    listSettings.mockResolvedValueOnce([
      {
        key: "site_title",
        value: "Anutech",
        description: "Brand name",
        category: "general",
        updatedAt: new Date("2026-06-01"),
        updatedBy: "admin@example.com",
      },
      {
        key: "2fa_required",
        value: true,
        category: "security",
        updatedAt: new Date("2026-06-02"),
        updatedBy: "admin@example.com",
      },
    ]);
    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.site_title).toEqual(
      expect.objectContaining({
        value: "Anutech",
        category: "general",
      })
    );
    expect(body.settings["2fa_required"]).toEqual(
      expect.objectContaining({
        value: true,
        category: "security",
      })
    );
  });

  it("empty settings list → settings:{} ", async () => {
    listSettings.mockResolvedValueOnce([]);
    const res = await GET(makeReq("GET"));
    const body = await res.json();
    expect(body.settings).toEqual({});
  });
});

// ─────────────────────────── POST ─────────────────────────────

describe("POST — admin gate", () => {
  it("non-admin → 401; no upsert", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await POST(
      makeReq("POST", { key: "site_title", value: "x" })
    );
    expect(res.status).toBe(401);
    expect(upsertSetting).not.toHaveBeenCalled();
  });
});

describe("POST — zod schema", () => {
  it("missing key → 400", async () => {
    const res = await POST(makeReq("POST", { value: "x" }));
    expect(res.status).toBe(400);
  });

  it("key > 100 chars → 400", async () => {
    const res = await POST(
      makeReq("POST", { key: "x".repeat(101), value: "v" })
    );
    expect(res.status).toBe(400);
  });

  it("missing value → 400 (refine: !== undefined required)", async () => {
    const res = await POST(makeReq("POST", { key: "site_title" }));
    expect(res.status).toBe(400);
  });

  it("value can be boolean / number / nested object (z.unknown)", async () => {
    getSetting.mockResolvedValue(null);
    const res = await POST(
      makeReq("POST", {
        key: "site_title",
        value: { nested: { fields: [1, 2, 3] } },
      })
    );
    expect(res.status).toBe(200);
    expect(upsertSetting).toHaveBeenCalledWith(
      "site_title",
      { nested: { fields: [1, 2, 3] } },
      expect.any(Object)
    );
  });
});

describe("POST — Security-key step-up auth (THE BIG ONE)", () => {
  it("SECURITY_KEYS allowlist hit → reauth required; failed reauth → 403 REAUTH_REQUIRED; NO upsert", async () => {
    requireReAuth.mockResolvedValueOnce({ passed: false });
    getSetting.mockResolvedValueOnce(null); // setting doesn't exist yet
    const res = await POST(
      makeReq("POST", {
        key: "directadmin_api_key", // in allowlist
        value: "new-secret-token",
        category: "general", // hostile attempt
      })
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("REAUTH_REQUIRED");
    expect(upsertSetting).not.toHaveBeenCalled();
  });

  it("**HOSTILE PROBE: body category='general' on security key → reauth STILL required (allowlist OVERRIDES body)**", async () => {
    requireReAuth.mockResolvedValueOnce({ passed: true });
    getSetting.mockResolvedValueOnce(null);
    await POST(
      makeReq("POST", {
        key: "razorpay_live_key_secret",
        value: "new-secret",
        category: "branding", // hostile bypass attempt
      })
    );
    expect(requireReAuth).toHaveBeenCalledTimes(1);
    expect(requireReAuth).toHaveBeenCalledWith(expect.anything(), "ADMIN1");
  });

  it("**STORED CATEGORY='security' on key NOT in allowlist → reauth required**", async () => {
    requireReAuth.mockResolvedValueOnce({ passed: true });
    // Key not in SECURITY_KEYS, but stored category is 'security'
    getSetting.mockResolvedValueOnce({
      key: "custom_secret_thing",
      category: "security",
    });
    await POST(
      makeReq("POST", {
        key: "custom_secret_thing",
        value: "new-secret",
        category: "general", // hostile
      })
    );
    expect(requireReAuth).toHaveBeenCalledTimes(1);
  });

  it("Non-security key + stored category not 'security' → no reauth required; goes straight to upsert", async () => {
    getSetting.mockResolvedValueOnce({
      key: "site_title",
      category: "general",
    });
    await POST(makeReq("POST", { key: "site_title", value: "New Site" }));
    expect(requireReAuth).not.toHaveBeenCalled();
    expect(upsertSetting).toHaveBeenCalledTimes(1);
  });

  // Feature flags are explicitly NOT security-scoped, even if their
  // stored category happens to be "security" (e.g. from a historical
  // save before this exception was added). Without this carve-out, the
  // first save would write category="security", and every subsequent
  // save would 403 with REAUTH_REQUIRED — and there's no step-up UI
  // for plain feature flags, so the admin would be stuck.
  it.each([
    "captcha_enabled",
    "hosting_trial_enabled",
    "hosting_test_plan_enabled",
    "tld_pricing_cache_enabled",
    "tld_pricing_cache_ttl",
    "maintenance_mode_enabled",
  ])(
    "NEVER_SECURITY_KEYS exception: %s with stored category='security' STILL skips reauth (feature flag, not credential)",
    async (key) => {
      getSetting.mockResolvedValueOnce({ key, category: "security" });
      await POST(
        makeReq("POST", { key, value: true, category: "feature_flags" })
      );
      expect(requireReAuth).not.toHaveBeenCalled();
      expect(upsertSetting).toHaveBeenCalledTimes(1);
    }
  );

  it("NEVER_SECURITY_KEYS exception does NOT bypass reauth for hardcoded SECURITY_KEYS (defense-in-depth — the allowlist always wins)", async () => {
    // cron_secret is in SECURITY_KEYS. Even if a future maintainer
    // accidentally adds it to NEVER_SECURITY_KEYS, the SECURITY_KEYS
    // check runs first and requires reauth.
    getSetting.mockResolvedValueOnce(null);
    requireReAuth.mockResolvedValueOnce({ passed: true });
    await POST(
      makeReq("POST", { key: "cron_secret", value: "rotated", category: "feature_flags" })
    );
    expect(requireReAuth).toHaveBeenCalledTimes(1);
  });

  it("First-time write of a security key (no existing setting) → reauth still fires (allowlist alone is enough)", async () => {
    getSetting.mockResolvedValueOnce(null);
    requireReAuth.mockResolvedValueOnce({ passed: true });
    await POST(
      makeReq("POST", { key: "cron_secret", value: "new-cron-secret" })
    );
    expect(requireReAuth).toHaveBeenCalledTimes(1);
  });

  it("reauth check uses the ADMIN's own _id (anti-impersonation)", async () => {
    getSetting.mockResolvedValueOnce(null);
    requireReAuth.mockResolvedValueOnce({ passed: true });
    await POST(makeReq("POST", { key: "auth_secret", value: "x" }));
    expect(requireReAuth).toHaveBeenCalledWith(expect.anything(), "ADMIN1");
  });
});

describe("POST — defaults + happy path", () => {
  it("missing description → defaults to ''", async () => {
    getSetting.mockResolvedValue(null);
    await POST(
      makeReq("POST", { key: "site_title", value: "x", category: "general" })
    );
    const optsArg = upsertSetting.mock.calls[0][2];
    expect(optsArg.description).toBe("");
  });

  it("missing category → defaults to 'general'", async () => {
    getSetting.mockResolvedValue(null);
    await POST(makeReq("POST", { key: "site_title", value: "x" }));
    const optsArg = upsertSetting.mock.calls[0][2];
    expect(optsArg.category).toBe("general");
  });

  it("updatedBy set to admin.email (not _id, not anonymous)", async () => {
    getSetting.mockResolvedValue(null);
    await POST(makeReq("POST", { key: "site_title", value: "x" }));
    const optsArg = upsertSetting.mock.calls[0][2];
    expect(optsArg.updatedBy).toBe("admin@example.com");
  });

  it("post-write re-reads the setting and returns canonical shape", async () => {
    const stored = {
      key: "site_title",
      value: "Anutech",
      description: "Brand",
      category: "branding",
      updatedAt: new Date("2026-06-13"),
      updatedBy: "admin@example.com",
    };
    getSetting
      .mockResolvedValueOnce(null) // pre-write security-check
      .mockResolvedValueOnce(stored); // post-write read
    const res = await POST(
      makeReq("POST", { key: "site_title", value: "Anutech" })
    );
    const body = await res.json();
    expect(body.setting).toEqual({
      key: "site_title",
      value: "Anutech",
      description: "Brand",
      category: "branding",
      updatedAt: expect.any(String),
      updatedBy: "admin@example.com",
    });
  });

  it("post-write re-read null → setting:null in response (defensive)", async () => {
    getSetting
      .mockResolvedValueOnce(null) // pre-write security-check
      .mockResolvedValueOnce(null); // post-write read also null
    const res = await POST(
      makeReq("POST", { key: "site_title", value: "x" })
    );
    const body = await res.json();
    expect(body.setting).toBeNull();
    expect(body.success).toBe(true);
  });
});

describe("POST — outer catch", () => {
  it("upsertSetting throw → 500 generic; sentinel NOT leaked", async () => {
    getSetting.mockResolvedValueOnce(null);
    upsertSetting.mockRejectedValueOnce(
      new Error("Mongo down — $2a$12$BCRYPT_LEAK_ME")
    );
    const res = await POST(
      makeReq("POST", { key: "site_title", value: "x" })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to update setting");
    expect(JSON.stringify(body)).not.toContain("$2a$12$BCRYPT_LEAK_ME");
  });
});
