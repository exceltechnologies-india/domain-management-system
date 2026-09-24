/**
 * Where ResellerOS lives, and whether it is the front door.
 *
 * In the integrated setup ResellerOS is the public site and DMS is the
 * hosting/domain panel behind it. One variable drives both halves of that:
 *
 *   set   → `/` redirects to ResellerOS, and every "home"/brand link in DMS
 *           points there instead of at DMS's own marketing pages.
 *   unset → there is NO public site. Until 24 Sep 2026 this meant "DMS
 *           behaves as it always has, standalone, with its own homepage". The
 *           owner then had DMS's public pages deleted, so a DMS without this
 *           variable 404s on `/`, the legal pages and the old shop pages.
 *           The panel, cart and checkout still work. That is why the deploy
 *           script now refuses to run with it unset: the variable is a
 *           requirement, no longer an opt-in.
 *
 * ── Why NEXT_PUBLIC_, and what that costs ────────────────────────────────
 * The value has to reach the BROWSER: Navigation and UserLayout are
 * `'use client'`, so a server-only variable cannot be read there at all.
 * NEXT_PUBLIC_ is inlined by Next at BUILD time, not read at runtime — so
 * changing it needs a rebuild, and setting it only on the running container
 * does nothing. docker-compose.yml passes it as a build arg for exactly that
 * reason, the same as NEXT_PUBLIC_SHOW_DEMO_ACCOUNTS.
 *
 * That trade is acceptable here because the value is a link target baked
 * into HTML, with no runtime behaviour hanging off it. Do not copy this
 * shape for anything a running server has to decide.
 */

/**
 * The ResellerOS origin, with any trailing slash removed — or `null` when it
 * is not configured or is unusable.
 *
 * Returning `null` rather than `""` is deliberate. An empty base produces a
 * RELATIVE url, and a relative url in an href is not a degraded link, it is a
 * link that silently goes to the wrong app. Callers must decide what to do
 * with "unknown", and the type makes them.
 */
export function resellerOsUrl(): string | null {
  const raw = (process.env.NEXT_PUBLIC_RESELLEROS_URL ?? "").trim();
  if (!raw) return null;
  // A bare host ("reselleros.example.com") is not a link a browser can
  // follow from here — it resolves against the current path. Refuse it
  // rather than emit something that looks fine and lands nowhere.
  if (!/^https?:\/\//i.test(raw)) return null;
  return raw.replace(/\/+$/, "");
}

/**
 * Where a "home" or brand link should point.
 *
 * Falls back to DMS's own `/` when ResellerOS is not configured, which is
 * correct in both directions: standalone DMS keeps working, and in the
 * integrated setup `/` redirects to ResellerOS anyway, so a stale link costs
 * one hop rather than a dead end.
 */
export function homeUrl(): string {
  return resellerOsUrl() ?? "/";
}

/**
 * True when ResellerOS owns the public frontpage, so DMS's own marketing
 * homepage should not be served.
 */
export function frontpageIsDelegated(): boolean {
  return resellerOsUrl() !== null;
}

/**
 * DMS marketing/legal pages that ResellerOS owns once it is the front door,
 * mapped to the ResellerOS page that replaces each one.
 *
 * These are REDIRECTS, not 404s, and the difference is not cosmetic. Razorpay
 * requires a merchant's policy pages to be publicly reachable; making them
 * disappear would put the payment account at risk. Every entry here points at
 * a page that exists in ResellerOS (`(public)/privacy`, `(public)/terms`,
 * `(marketing)/refund`, `(public)/enquiry`, `(public)/about` — route groups do
 * not affect the URL), so the content stays public, just at one origin instead
 * of two. If a target is ever removed from ResellerOS, remove it here too
 * rather than leaving a redirect into a 404.
 *
 * `/contact` maps to `/enquiry` because that is ResellerOS's public
 * get-in-touch page; there is no `/contact` there, and `(app)/contacts` is the
 * CRM module, which is a different thing behind a login.
 *
 * ── The pages themselves are GONE, not merely redirected (24 Sep 2026) ────
 * Owner decision: DMS's public frontend pages are removed, because the
 * ResellerOS frontend is the one in use. None of the paths below has a page
 * in `app/` any more; this map is the only thing those URLs still do. So with
 * the front door unset they 404 — which is why `scripts/deploy-cloud-run.sh`
 * refuses to deploy without NEXT_PUBLIC_RESELLEROS_URL. Before that date an
 * admin was shown DMS's own copy instead of being redirected; there is no
 * copy to show now.
 *
 *   /hosting, /domains-home, /domains/search, /domains/bulk-search
 *       -> ResellerOS's own /hosting and /domains. A customer already inside
 *          the panel buys through the panel dialogs instead
 *          (lib/purchase/buy-dialog.ts), which never pass through here.
 *   /data-deletion -> /privacy. ResellerOS has no data-deletion page; the
 *          owner chose to remove DMS's anyway. If Facebook login is ever
 *          switched on, Meta will want a data-deletion URL — that is the
 *          consequence of this line, recorded so it is not rediscovered.
 *
 * `/hosting/error` is NOT here and must not be: it is where the control-panel
 * SSO routes land on failure (api/user/hosting/sso), a panel page rather than
 * marketing. Matching is by exact path, so it is unaffected.
 */
const RESELLEROS_OWNED_PAGES: Readonly<Record<string, string>> = Object.freeze({
  "/privacy": "/privacy",
  "/terms-and-conditions": "/terms",
  "/cancellation-refund": "/refund",
  "/contact": "/enquiry",
  "/about": "/about",
  "/hosting": "/hosting",
  "/domains-home": "/domains",
  "/domains/search": "/domains",
  "/domains/bulk-search": "/domains",
  "/data-deletion": "/privacy",
});

/**
 * The absolute ResellerOS URL that should replace this DMS path, or `null`
 * when DMS still owns it — which includes every path when the front door is
 * not configured at all.
 */
export function resellerOsOwnedUrl(pathname: string): string | null {
  const front = resellerOsUrl();
  if (!front) return null;
  const target = RESELLEROS_OWNED_PAGES[pathname];
  return target ? `${front}${target}` : null;
}

/** The DMS paths ResellerOS takes over. Exported for tests and tooling. */
export function resellerOsOwnedPaths(): string[] {
  return Object.keys(RESELLEROS_OWNED_PAGES);
}

/**
 * The href a DMS link to a public page should actually carry.
 *
 * Standalone DMS gets the path it always had. With ResellerOS as the front
 * door it gets the absolute ResellerOS URL — the SAME url the middleware
 * would have redirected to, so the destination is unchanged and the redirect
 * hop is removed.
 *
 * It exists because of a console error, and the console error was the only
 * symptom. Next prefetches a `<Link href="/privacy">`; the prefetch is an RSC
 * *fetch*, so DMS's own 307 to the ResellerOS origin is a cross-origin
 * connect and `connect-src 'self' …` refuses it:
 *
 *   Connecting to 'https://…/privacy' violates the following Content
 *   Security Policy directive: "connect-src 'self' data: blob: wss: …"
 *
 * Measured before deciding anything: the CLICK still works. It is a plain
 * navigation, which CSP does not police, and it lands on the ResellerOS page
 * — error count 1 before the click and 1 after. So this is not a dead link,
 * it is one refused prefetch per page view, on every public page, forever.
 * That is worth removing precisely because it is harmless: a violation nobody
 * needs to act on is what teaches the next reader to skim the console
 * (AGENTS.md L6).
 *
 * The fix deliberately is NOT widening `connect-src` to admit the ResellerOS
 * origin. That would buy a silent console by letting every DMS page fetch
 * another origin, which is a real permission traded for a cosmetic one.
 * Pointing the link at its true destination costs nothing and is faster.
 *
 * `prefetch={false}` at each call site would also have worked and was
 * rejected: it is one decision copied to a dozen places, which is the exact
 * shape AGENTS.md L98 keeps recording, and it leaves the wasted redirect.
 */
export function publicPageHref(pathname: string): string {
  return resellerOsOwnedUrl(pathname) ?? pathname;
}


/**
 * Anchors into DMS's own homepage, and where each one lives once ResellerOS
 * owns that homepage.
 *
 * These are the links that were BROKEN rather than merely slow, and the
 * difference matters. A legal link that redirects still reaches the right
 * page; `/#pricing` reaches ResellerOS's marketing home, which has no
 * `pricing` anchor, so the browser lands at the top of a page that cannot
 * sell anything — on the nav items whose entire job is to start a purchase.
 *
 * Every replacement below was checked rather than assumed, on 23 Sep 2026:
 * each serves 200 from DMS, none is in the redirect map, and the anchor named
 * in the target really exists in that page's source.
 *
 *   #domain-search  -> /domains-home
 *   #pricing        -> /hosting#pricing
 *
 * ── Superseded 24 Sep 2026 ──────────────────────────────────────────────
 * Those targets were kept inside DMS "because DMS is still the only thing
 * that can sell hosting or a domain". That stopped being true: ResellerOS's
 * cart is primary for a first purchase, and DMS's /hosting and /domains-home
 * pages are deleted. So both anchors now resolve to the ResellerOS pages that
 * sell those things, through the same map as every other public page.
 *
 * A SIGNED-IN customer does not use these at all — Navigation sends them to
 * the in-panel purchase dialogs (lib/purchase/buy-dialog.ts), because the
 * owner's decision keeps in-panel buying on DMS's own cart.
 */
const HOME_ANCHOR_TARGETS: Readonly<Record<string, string>> = Object.freeze({
  "domain-search": "/domains-home",
  pricing: "/hosting",
});

/**
 * Where a nav item that used to point at `/#<anchor>` should point.
 *
 * Standalone DMS keeps the anchor — `/` is its own homepage there and
 * `components/marketing/HostingLanding.tsx` carries both ids.
 *
 * An anchor with no entry falls back to the old behaviour rather than to
 * nothing: an unmapped anchor is a link nobody has thought about yet, and one
 * refused prefetch is a better failure than a link that goes nowhere.
 */
export function homeAnchorHref(anchor: string): string {
  const key = anchor.replace(/^#/, "");
  if (!frontpageIsDelegated()) return `/#${key}`;
  const target = HOME_ANCHOR_TARGETS[key];
  return target ? publicPageHref(target) : `/#${key}`;
}

/** The anchors this module knows how to re-point. Exported for tests. */
export function homeAnchorKeys(): string[] {
  return Object.keys(HOME_ANCHOR_TARGETS);
}
