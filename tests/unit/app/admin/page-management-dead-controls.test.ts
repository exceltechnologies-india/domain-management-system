/**
 * Admin → Appearance (/admin/page-management) — the dead controls stay gone.
 *
 * Until 25 Sep 2026 this screen opened with publish/draft switches for DMS's
 * public marketing pages and a "Homepage design" switch. Those pages were
 * deleted on 24 Sep 2026 and every URL is now a 307 to ResellerOS, so the
 * switches changed nothing; the owner chose to remove them (decision 15).
 *
 * A switch that changes nothing reads to an operator exactly like one that
 * works, so this pins the removal: the files that existed only to serve them
 * are gone, and neither the screen nor the API accepts them any more.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Source with comments removed, so the header explaining the removal does not trip it (L46). */
function code(p: string): string {
  return read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the dead page-management controls stay removed", () => {
  it.each([
    "config/managed-pages.ts",
    "lib/services/page-visibility.ts",
    "app/api/admin/pages",
  ])("%s does not exist", (p) => {
    expect(existsSync(join(ROOT, p))).toBe(false);
  });

  it("the admin screen no longer loads or toggles page visibility, nor the homepage design", () => {
    const src = code("app/admin/page-management/page.tsx");
    expect(src).not.toMatch(/\/api\/v1\/admin\/pages/);
    expect(src).not.toMatch(/homeVariant/);
    expect(src).not.toMatch(/Homepage design/);
  });

  it("the appearance API and service no longer carry the homepage design", () => {
    expect(code("app/api/admin/appearance/route.ts")).not.toMatch(/homeVariant|HomeVariant/);
    expect(code("lib/services/appearance.ts")).not.toMatch(/HomeVariant|home_variant/);
  });

  it("the controls that still style live pages survive", () => {
    // Footer (cart / checkout / error pages) and the login/cart colour theme are real.
    const src = code("app/admin/page-management/page.tsx");
    expect(src).toMatch(/footerVariant/);
    expect(src).toMatch(/frontendTheme/);
    expect(code("app/api/admin/appearance/route.ts")).toMatch(/footerVariant/);
  });

  it("the nav entry names what is left on the screen", () => {
    const nav = read("components/admin/AdminLayout.tsx");
    expect(nav).toMatch(/name: 'Appearance', href: '\/admin\/page-management'/);
    expect(nav).not.toMatch(/name: 'Pages'/);
  });
});
