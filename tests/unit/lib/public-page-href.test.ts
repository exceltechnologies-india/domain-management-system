/**
 * `publicPageHref` — and a SOURCE SCAN that no link bypasses it.
 *
 * The behaviour is four lines and the scan is the point. What went wrong was
 * never the logic: seventeen links across six files each carried a literal
 * `href="/privacy"`-shaped path, every one of them correct on the day it was
 * written, and together they meant DMS asked its own server for a page it no
 * longer serves. The prefetch of that 307 is a cross-origin connect, so
 * `connect-src 'self' …` refused it once per page view.
 *
 * AGENTS.md L98 is this shape and says what to do about it: when a decision
 * has to hold at N call sites, assert the call sites, not only the decision.
 * A unit test on `publicPageHref` would stay green forever while somebody
 * adds an eighteenth footer link with a literal path.
 *
 * Measured before any of this was written: the click always worked. The
 * refused request was the prefetch, not the navigation. This is a tidy-up of
 * console noise and a removed redirect hop, and saying so is the honest
 * framing — see the header of `lib/reseller-os.ts` for why the alternative
 * (widening `connect-src`) was refused.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { publicPageHref, resellerOsOwnedPaths } from "@/lib/reseller-os";

const ORIGINAL = process.env.NEXT_PUBLIC_RESELLEROS_URL;

function set(value: string | undefined) {
  if (value === undefined) delete process.env.NEXT_PUBLIC_RESELLEROS_URL;
  else process.env.NEXT_PUBLIC_RESELLEROS_URL = value;
}

beforeEach(() => set(undefined));
afterEach(() => set(ORIGINAL));

describe("publicPageHref", () => {
  it("standalone DMS keeps the path it always had", () => {
    // The whole point of the front-door switch defaulting to off: a DMS
    // deployment that is not behind ResellerOS must be untouched by this.
    for (const p of resellerOsOwnedPaths()) {
      expect(publicPageHref(p)).toBe(p);
    }
  });

  it("with a front door, points at the SAME url the middleware would redirect to", () => {
    set("https://app.example.com");
    expect(publicPageHref("/privacy")).toBe("https://app.example.com/privacy");
    // Not every path keeps its name across the two apps — this is why the
    // links cannot simply be prefixed with the origin by hand.
    expect(publicPageHref("/terms-and-conditions")).toBe("https://app.example.com/terms");
    expect(publicPageHref("/cancellation-refund")).toBe("https://app.example.com/refund");
    expect(publicPageHref("/contact")).toBe("https://app.example.com/enquiry");
    expect(publicPageHref("/about")).toBe("https://app.example.com/about");
  });

  it("leaves a path ResellerOS does not own alone, front door or not", () => {
    set("https://app.example.com");
    // DMS keeps its own dashboard, login and everything else. Sending one of
    // those to ResellerOS would be a dead link, not a redirect.
    expect(publicPageHref("/login")).toBe("/login");
    expect(publicPageHref("/dashboard")).toBe("/dashboard");
  });

  it("a malformed front door falls back to the DMS path rather than to nothing", () => {
    // `resellerOsUrl` refuses a bare host, and the fallback has to be the
    // working relative path — an empty href is a link that goes nowhere.
    set("app.example.com");
    expect(publicPageHref("/privacy")).toBe("/privacy");
  });
});

/** Every .tsx under components/ and app/, so the scan cannot quietly shrink. */
function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/**
 * Comments stripped before asserting an ABSENCE (AGENTS.md L46). A blunt scan
 * makes "do not write href=\"/privacy\" here, use publicPageHref" a failing
 * test, which pushes the reasoning out of the file to satisfy the tooling.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

describe("no link bypasses the helper", () => {
  const root = process.cwd();
  const files = [...tsxFiles(join(root, "components")), ...tsxFiles(join(root, "app"))];

  it("the scan actually scanned something", () => {
    // Guard the guard: a moved directory would make the assertion below pass
    // by finding no files at all.
    expect(files.length).toBeGreaterThan(100);
  });

  it.each(resellerOsOwnedPaths())("no component hardcodes href=%s", (path) => {
    const literal = new RegExp(`href=["']${path.replace(/\//g, "\\/")}["']`);
    const offenders = files
      .filter((f) => literal.test(code(readFileSync(f, "utf8"))))
      .map((f) => relative(root, f));

    expect(
      offenders,
      `these link straight at ${path}, which DMS 307s to ResellerOS. ` +
        `Use publicPageHref('${path}') so the link goes to the destination ` +
        `rather than to a redirect whose prefetch CSP refuses.`
    ).toEqual([]);
  });

  it("and the helper is genuinely in use, not merely undefeated", () => {
    /**
     * The assertions above are satisfied by deleting every link. This one
     * fails if the links vanish, so "no offenders" means the links were
     * converted rather than removed.
     */
    const users = files.filter((f) => code(readFileSync(f, "utf8")).includes("publicPageHref("));
    expect(users.length).toBeGreaterThanOrEqual(6);
  });
});
