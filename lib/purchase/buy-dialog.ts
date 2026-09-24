/**
 * The in-panel purchase dialogs, and the one link format that opens them.
 *
 * Owner decision, 24 Sep 2026: a customer's FIRST purchase happens on
 * ResellerOS, and DMS's public marketing pages are removed. A customer who is
 * already inside the DMS panel still buys through DMS's own cart — so the
 * panel needs somewhere to pick a hosting plan or a domain that is not a
 * full marketing page. That is these two dialogs.
 *
 * They open from a query parameter rather than from local state so that any
 * link can reach them — the empty cart, the navigation bar, a panel page's
 * empty state — without each one importing a modal and wiring its own
 * open/close. One format, parsed in one place (AGENTS.md L98: one decision,
 * not a copy per call site).
 *
 * The dialogs are mounted by `components/user/UserLayout.tsx`, so the link
 * must land on a page that renders that layout. Each kind points at the panel
 * page it belongs to, which also means closing the dialog leaves the customer
 * somewhere sensible rather than on a blank dashboard.
 */

export const BUY_PARAM = "buy";
export const QUERY_PARAM = "q";

export type BuyKind = "hosting" | "domain";

const HOME: Readonly<Record<BuyKind, string>> = Object.freeze({
  hosting: "/dashboard/hosting",
  domain: "/dashboard/domains",
});

/**
 * The href that opens a purchase dialog.
 *
 * `query` pre-fills the domain search, so a search typed elsewhere carries
 * into the dialog instead of being dropped. It is ignored for hosting, which
 * has nothing to search.
 */
export function buyHref(kind: BuyKind, query?: string): string {
  const params = new URLSearchParams({ [BUY_PARAM]: kind });
  const q = (query ?? "").trim();
  if (kind === "domain" && q) params.set(QUERY_PARAM, q);
  return `${HOME[kind]}?${params.toString()}`;
}

/**
 * Which dialog a `?buy=` value asks for, or `null` for anything else.
 *
 * Exact match only. A typo or a stale link must open nothing rather than
 * guess — a wrong dialog is a customer looking at the wrong product.
 */
export function parseBuyKind(value: string | null | undefined): BuyKind | null {
  return value === "hosting" || value === "domain" ? value : null;
}
