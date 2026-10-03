/**
 * Customer screens wear the ResellerOS storefront brand, Anutech blue #1668E3 (Pawan, 3 Oct 2026).
 * The old violet theme (#7C3AED family) was also hard-coded into a few components — the domain
 * Search button, the top-bar button, the highlighted pricing card — where removing the theme
 * switch could not reach it. This fails if that violet comes back on any non-admin screen.
 * Category colours (a CNAME badge, a "Domain" ticket tag) use Tailwind's violet/purple scales
 * and are not brand accents, so they are not scanned.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const VIOLET = /#7C3AED|#6D28D9|#8B5CF6|124,\s*58,\s*237/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts|css)$/.test(e)) out.push(p);
  }
  return out;
}

describe("no violet brand accent on customer screens", () => {
  const files = [...walk(join(ROOT, "components")), ...walk(join(ROOT, "app"))]
    .map((p) => relative(ROOT, p).split("\\").join("/"))
    .filter((p) => !/^(app|components)\/admin\//.test(p) && !p.startsWith("app/api/"));

  it("the scan covers the customer components", () => {
    expect(files).toContain("components/domain-search/SearchInput.tsx");
    expect(files).toContain("components/PricingCard.tsx");
  });

  it("none carries the old violet", () => {
    const hits = files.filter((p) => VIOLET.test(readFileSync(join(ROOT, p), "utf8")));
    expect(hits).toEqual([]);
  });
});
