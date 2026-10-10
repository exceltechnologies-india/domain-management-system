/**
 * lib/theme — the portal reads ResellerOS's theme at runtime (10 Oct 2026). Pinned: only plain
 * colour triplets ever reach the <style> tag; the CSS carries every token on `.ros-theme`; and the
 * bundled fallback equals ResellerOS's own tokens.ts when that repo is beside this one.
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_THEME, THEME_TOKEN_NAMES, parseTheme, themeToCss } from "@/lib/theme/theme";
import { fetchPortalTheme, resetThemeCache } from "@/lib/theme/fetch-theme";

const ENV = { RESELLEROS_SERVER_URL: "https://ros.example.test/" };
const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

beforeEach(() => resetThemeCache());

describe("parseTheme", () => {
  it("accepts ResellerOS's theme as served", () => {
    expect(parseTheme(DEFAULT_THEME)).toEqual(DEFAULT_THEME);
  });
  it("refuses anything but a plain colour triplet — no CSS injection", () => {
    const evil = { ...DEFAULT_THEME, light: { ...DEFAULT_THEME.light, paper: "0 0% 100%; } body { display:none" } };
    expect(parseTheme(evil)).toBeNull();
    expect(parseTheme({ ...DEFAULT_THEME, accentScale: { ...DEFAULT_THEME.accentScale, "600": "red" } })).toBeNull();
    expect(parseTheme({ ...DEFAULT_THEME, dark: undefined })).toBeNull();
    const missing = { ...DEFAULT_THEME, light: { ...DEFAULT_THEME.light } } as Record<string, unknown>;
    delete (missing.light as Record<string, unknown>).amber;
    expect(parseTheme(missing)).toBeNull();
    expect(parseTheme(null)).toBeNull();
  });
  it("sanitises the version and scope labels that go into a CSS comment", () => {
    const t = parseTheme({ ...DEFAULT_THEME, version: "*/ body{}", scope: "<x>" });
    expect(t?.version).toBe("unknown");
    expect(t?.scope).toBe("platform");
  });
});

describe("themeToCss", () => {
  it("sets every token and the primary scale on .ros-theme, and the dark set under .dark", () => {
    const css = themeToCss(DEFAULT_THEME);
    for (const n of THEME_TOKEN_NAMES) expect(css).toContain(`--${n}: ${DEFAULT_THEME.light[n]};`);
    expect(css).toContain("--primary-600: 194 65 12;");
    expect(css).toContain(".dark .ros-theme, .ros-theme.dark {");
    expect(css).toContain(`--paper: ${DEFAULT_THEME.dark.paper};`);
  });
});

describe("fetchPortalTheme", () => {
  it("reads /api/public/theme from ResellerOS and keeps it five minutes", async () => {
    const changed = { ...DEFAULT_THEME, version: "2027-01-01", light: { ...DEFAULT_THEME.light, amber: "200 80% 40%" } };
    const f = reply(200, changed);
    let t = 0;
    const r = await fetchPortalTheme({ env: ENV, fetchImpl: f, now: () => t });
    expect(r.source).toBe("reselleros");
    expect(r.theme.light.amber).toBe("200 80% 40%"); // a ResellerOS change reaches the portal with no DMS change
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe("https://ros.example.test/api/public/theme");
    t = 4 * 60_000;
    await fetchPortalTheme({ env: ENV, fetchImpl: f, now: () => t });
    expect(f).toHaveBeenCalledTimes(1);
    t = 6 * 60_000;
    await fetchPortalTheme({ env: ENV, fetchImpl: f, now: () => t });
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("falls back to the bundled theme when ResellerOS is unset, down, or sends junk — and never throws", async () => {
    expect(await fetchPortalTheme({ env: {} })).toEqual({ theme: DEFAULT_THEME, source: "default" });
    resetThemeCache();
    expect((await fetchPortalTheme({ env: ENV, fetchImpl: reply(502, {}) })).source).toBe("default");
    resetThemeCache();
    const boom = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    expect((await fetchPortalTheme({ env: ENV, fetchImpl: boom as unknown as typeof fetch })).source).toBe("default");
    resetThemeCache();
    expect((await fetchPortalTheme({ env: ENV, fetchImpl: reply(200, { light: "nope" }) })).theme).toEqual(DEFAULT_THEME);
  });
  it("remembers a failure for a minute, so a down ResellerOS doesn't slow every page", async () => {
    const f = reply(502, {});
    let t = 0;
    await fetchPortalTheme({ env: ENV, fetchImpl: f, now: () => t });
    t = 30_000;
    await fetchPortalTheme({ env: ENV, fetchImpl: f, now: () => t });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("the bundled fallback = ResellerOS's tokens.ts", () => {
  it("matches when the ResellerOS repo is beside this one", () => {
    const path = "../anutechbilling-new/production/src/lib/theme/tokens.ts";
    if (!existsSync(path)) return; // not on this machine — the copy above is the contract
    const ros = readFileSync(path, "utf8");
    for (const mode of ["light", "dark"] as const) {
      for (const n of THEME_TOKEN_NAMES) {
        const key = n.includes("-") ? `"${n}"` : n;
        expect(ros, `${mode} ${n}`).toContain(`${key}: "${DEFAULT_THEME[mode][n]}"`);
      }
    }
    expect(ros).toContain(`"600": "${DEFAULT_THEME.accentScale["600"]}"`);
  });
});
