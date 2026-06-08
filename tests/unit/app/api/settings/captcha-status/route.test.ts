/**
 * Tests for `app/api/settings/captcha-status/route.ts` (slice 7gm,
 * part 3). Tells the front-end whether to render the reCAPTCHA
 * widget on login / signup / contact forms.
 *
 * **Critical security pin: fail-CLOSED on error.** If the settings
 * read throws, the response must default to enabled=true so that
 * captcha is NEVER silently skipped. The default in the source is
 * also true (second arg to getSetting) — pinned here.
 *
 * Pins:
 *  - getSetting('captcha_enabled', true) — default arg = true
 *  - value === true → enabled:true
 *  - value === 'true' (string from settings UI) → enabled:true
 *    (lenient string parsing — settings forms often store strings)
 *  - value === false → enabled:false
 *  - value === 'false' or any other non-true string → enabled:false
 *  - SettingsService throw → enabled:true (fail-CLOSED, anti-bypass)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getSetting = vi.hoisted(() => vi.fn());
vi.mock("@/lib/settings-service", () => ({
  SettingsService: { getSetting },
}));

vi.unmock("next/server");
const { NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextResponse }));

import { GET } from "@/app/api/settings/captcha-status/route";

beforeEach(() => {
  getSetting.mockReset();
});

describe("GET — default arg to getSetting is `true`", () => {
  it("getSetting called with ('captcha_enabled', true) — DEFAULT IS TRUE", async () => {
    getSetting.mockResolvedValueOnce(true);
    await GET();
    expect(getSetting).toHaveBeenCalledWith("captcha_enabled", true);
  });
});

describe("GET — true / 'true' / false / 'false' parsing", () => {
  it("boolean true → enabled:true", async () => {
    getSetting.mockResolvedValueOnce(true);
    const res = await GET();
    const body = await res.json();
    expect(body.enabled).toBe(true);
  });

  it("string 'true' → enabled:true (lenient)", async () => {
    getSetting.mockResolvedValueOnce("true");
    const res = await GET();
    const body = await res.json();
    expect(body.enabled).toBe(true);
  });

  it("boolean false → enabled:false", async () => {
    getSetting.mockResolvedValueOnce(false);
    const res = await GET();
    const body = await res.json();
    expect(body.enabled).toBe(false);
  });

  it("string 'false' → enabled:false", async () => {
    getSetting.mockResolvedValueOnce("false");
    const res = await GET();
    const body = await res.json();
    expect(body.enabled).toBe(false);
  });

  it("any other string → enabled:false (strict 'true' only)", async () => {
    getSetting.mockResolvedValueOnce("yes");
    const res = await GET();
    const body = await res.json();
    expect(body.enabled).toBe(false);
  });
});

describe("GET — fail-CLOSED on error (anti-bypass)", () => {
  it("getSetting throws → enabled:true. Captcha must NOT silently turn off when settings break.", async () => {
    getSetting.mockRejectedValueOnce(new Error("Redis settings cache down"));
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
  });
});
