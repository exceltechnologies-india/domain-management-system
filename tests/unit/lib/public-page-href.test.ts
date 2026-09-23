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
import {
  homeAnchorHref,
  homeAnchorKeys,
  publicPageHref,
  resellerOsOwnedPaths,
} from "@/lib/reseller-os";

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

describe("homeAnchorHref", () => {
  /**
   * These are the links that were BROKEN rather than slow. `/#pricing` and
   * `/#domain-search` redirect to ResellerOS's marketing home, which carries
   * NEITHER anchor — so the two nav items whose job is to start a purchase
   * landed at the top of a page that cannot sell anything.
   */
  it("standalone keeps the anchor, which is real there", () => {
    // components/marketing/HostingLanding.tsx carries both ids, and `/` is
    // DMS's own homepage when there is no front door.
    expect(homeAnchorHref("domain-search")).toBe("/#domain-search");
    expect(homeAnchorHref("pricing")).toBe("/#pricing");
  });

  it("with a front door, goes to the DMS page that really has that content", () => {
    set("https://app.example.com");
    // No anchor: /domains-home renders <DomainSearch> at the top, so there is
    // nothing to scroll to. Carrying "#domain-search" would be a scroll
    // target that does not exist on the destination.
    expect(homeAnchorHref("domain-search")).toBe("/domains-home");
    // Anchor kept: id="pricing" is on HostingPageClient.tsx.
    expect(homeAnchorHref("pricing")).toBe("/hosting#pricing");
  });

  it("stays inside DMS, because DMS is still the only thing that can sell", () => {
    // The purchase funnel is deliberately DMS's. This must not be "fixed"
    // later by pointing it at the front door.
    set("https://app.example.com");
    for (const key of homeAnchorKeys()) {
      expect(homeAnchorHref(key).startsWith("http")).toBe(false);
    }
  });

  it("an unmapped anchor falls back to the old link, not to nothing", () => {
    /**
     * A link nobody has re-pointed yet keeps working as it did — one refused
     * prefetch, which is the failure this whole change is about and is still
     * far better than a dead href.
     */
    set("https://app.example.com");
    expect(homeAnchorHref("features")).toBe("/#features");
  });

  it("tolerates a leading # so a caller cannot get it subtly wrong", () => {
    expect(homeAnchorHref("#pricing")).toBe("/#pricing");
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

  /**
   * THREE shapes, and the first version of this scan only had the first.
   *
   * It passed, and `/cart` went on logging three violations: FooterModern
   * builds its links from a `{ label, href }` array and HostingPageClient
   * from a `{ cta, href }` one, so neither contains the string `href="/about"`
   * anywhere. The scan was green about files it could not see — which is
   * worse than no scan, because green here reads as coverage.
   *
   *   href="/about"          a JSX attribute
   *   href: '/about'         a value in a data array, rendered elsewhere
   *   router.push('/about')  a programmatic navigation
   */
  const SHAPES = [
    (p: string) => `href=["']${p}["']`,
    (p: string) => `href:\\s*["']${p}["']`,
    (p: string) => `router\\.push\\(\\s*["']${p}["']`,
  ];

  it.each(resellerOsOwnedPaths())("nothing hardcodes a link to %s", (path) => {
    const escaped = path.replace(/\//g, "\\/");
    const offenders = files
      .filter((f) => {
        const src = code(readFileSync(f, "utf8"));
        return SHAPES.some((shape) => new RegExp(shape(escaped)).test(src));
      })
      .map((f) => relative(root, f));

    expect(
      offenders,
      `these link straight at ${path}, which DMS 307s to ResellerOS. ` +
        `Use publicPageHref('${path}') so the link goes to the destination ` +
        `rather than to a redirect whose prefetch CSP refuses.`
    ).toEqual([]);
  });

  it("the data-array and router.push shapes are really matched, not just declared", () => {
    /**
     * Guard the guard, the specific way this scan failed once. If a future
     * edit tightens the pattern back to attributes only, the assertions above
     * keep passing on a codebase that has reintroduced the bug — so the
     * patterns are exercised against strings that must match.
     */
    const cases = [
      `<Link href="/about" className=`,
      `{ label: 'About Us', href: '/about' },`,
      `onClick={() => router.push('/about')}`,
    ];
    for (const sample of cases) {
      expect(
        SHAPES.some((shape) => new RegExp(shape("\\/about")).test(sample)),
        `no pattern matches: ${sample}`
      ).toBe(true);
    }
  });

  it('nothing links to DMS\'s own "/" either', () => {
    /**
     * `/` is not in the owned-paths map — it is handled by a separate
     * mechanism, the homepage redirect in app/page.tsx — so the loop above
     * cannot see it. It is the same defect all the same: nine `href="/"`
     * links across eight files, each prefetched, each 307ing to the
     * ResellerOS origin.
     *
     * It is also what the first diagnosis of the surviving /cart violation
     * missed. The blocked url a redirected fetch reports is the TARGET, so
     * `https://…:4320/` read as "something is prefetching the absolute Home
     * link" when it was an ordinary internal link to a redirecting page. A
     * prefetch={false} guard was written on that reading and reverted when
     * it changed nothing.
     */
    const offenders = files
      .filter((f) => /href=["']\/["']/.test(code(readFileSync(f, "utf8"))))
      .map((f) => relative(root, f));

    expect(
      offenders,
      'these link at DMS\'s "/", which redirects to ResellerOS when it is the ' +
        "front door. Use homeUrl() — it returns '/' when DMS is standalone, so " +
        "nothing changes for a deployment that is not federated."
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
