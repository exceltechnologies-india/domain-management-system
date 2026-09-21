/**
 * Where ResellerOS lives, and whether it is the front door.
 *
 * In the integrated setup ResellerOS is the public site and DMS is the
 * hosting/domain panel behind it. One variable drives both halves of that:
 *
 *   set   → `/` redirects to ResellerOS, and every "home"/brand link in DMS
 *           points there instead of at DMS's own marketing pages.
 *   unset → DMS behaves exactly as it always has, standalone, with its own
 *           homepage. Nothing is deleted, so a DMS deployment that is not
 *           behind ResellerOS is unaffected.
 *
 * The default is "unset" on purpose. A brake that changes what the app does
 * the moment it is merged is not a brake — turning the frontpage off has to
 * be a visible decision someone makes, not a side effect of deploying.
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
