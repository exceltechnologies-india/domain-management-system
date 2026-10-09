/**
 * What ResellerOS charges for a domain, per term — read server-side (9 Oct 2026).
 *
 * The portal cart priced a domain as the search's 1-year price × years and called the result
 * "incl. 18% GST", while ResellerOS (which takes the payment) charges ResellerClub's own total
 * for that term, before GST, plus 18%. A 1-year .in read ₹862.80 in the cart and was charged
 * ₹1,018; a term whose per-year price differs from the 1-year one would drift further.
 *
 * `GET <RESELLEROS_SERVER_URL>/api/domains/availability?name=&tlds=` — the same public lookup
 * the ResellerOS site's search and checkout use (lib/domains/live-lookup.ts), so the cart shows
 * the figure checkout charges. Its `prices` map is "term in years" → total in ₹ before GST.
 *
 * A good answer is kept for 60 seconds per domain; a failure is never kept, and there is no
 * fallback table (AGENTS.md §2).
 */
import { RESELLEROS_DOMAIN_TERMS } from "@/lib/reselleros/domain-terms";

/** Term in years ("1", "2", "3", "5") → total for that term in ₹, before GST. */
export type DomainTermTotals = Record<string, number>;

export type DomainTermPricesOutcome =
  | { ok: true; domain: string; available: boolean; totals: DomainTermTotals }
  | { ok: false; detail: string };

export interface FetchDomainTermPricesOptions {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Tests pass a clock; the cache compares against it. */
  now?: () => number;
}

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; out: Extract<DomainTermPricesOutcome, { ok: true }> }>();

/** Tests only: forget every cached answer. */
export function resetDomainTermPricesCache(): void {
  cache.clear();
}

/** A single registrable name, split into label and TLD; null for anything else. */
export function splitDomainName(raw: string): { name: string; tld: string } | null {
  const d = raw.trim().toLowerCase();
  const m = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.([a-z]{2,}(?:\.[a-z]{2,})?)$/.exec(d);
  return m ? { name: m[1], tld: m[2] } : null;
}

/** Keep only the offered terms with a positive whole-rupee total. Exported for tests. */
export function cleanTermTotals(raw: unknown): DomainTermTotals {
  const out: DomainTermTotals = {};
  if (!raw || typeof raw !== "object") return out;
  for (const t of RESELLEROS_DOMAIN_TERMS) {
    const v = Number((raw as Record<string, unknown>)[String(t)]);
    if (Number.isFinite(v) && v > 0) out[String(t)] = Math.round(v);
  }
  return out;
}

export async function fetchDomainTermPrices(
  domain: string,
  options: FetchDomainTermPricesOptions = {},
): Promise<DomainTermPricesOutcome> {
  const parts = splitDomainName(domain);
  if (!parts) return { ok: false, detail: `"${domain}" is not a single domain name` };
  const env = options.env ?? process.env;
  const raw = (env.RESELLEROS_SERVER_URL ?? "").trim();
  if (!/^https?:\/\//i.test(raw)) return { ok: false, detail: "RESELLEROS_SERVER_URL is not set on DMS" };
  const base = raw.replace(/\/+$/, "");
  const full = `${parts.name}.${parts.tld}`;
  const key = `${base}|${full}`;
  const now = (options.now ?? Date.now)();
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.out;

  const url = `${base}/api/domains/availability?name=${encodeURIComponent(parts.name)}&tlds=${encodeURIComponent(parts.tld)}`;
  let res: Response;
  try {
    res = await (options.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs ?? 12_000),
    });
  } catch (err) {
    return { ok: false, detail: `ResellerOS could not be reached: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}` };
  }
  if (res.status !== 200) return { ok: false, detail: `ResellerOS answered HTTP ${res.status}` };
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const rows = (body as { domains?: unknown } | null)?.domains;
  const row = Array.isArray(rows)
    ? (rows as { domain?: unknown; available?: unknown; priceKnown?: unknown; prices?: unknown }[]).find((r) => r?.domain === full)
    : undefined;
  if (!row) return { ok: false, detail: `ResellerOS returned no row for ${full}` };
  const totals = row.priceKnown === true ? cleanTermTotals(row.prices) : {};
  if (!totals["1"]) return { ok: false, detail: `ResellerOS has no price for ${full}` };
  const out = { ok: true as const, domain: full, available: row.available === true, totals };
  cache.set(key, { at: now, out });
  return out;
}

/** What the customer is told when the price cannot be confirmed (AGENTS.md §7). */
export const DOMAIN_PRICE_UNAVAILABLE =
  "We couldn't confirm this domain's price just now. The total shown is an estimate; " +
  "the payment window shows the exact amount before you pay.";
