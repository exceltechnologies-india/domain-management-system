/**
 * Read ResellerOS's hosting prices, server-side (owner, 28 Sep 2026: "Read prices live
 * from ResellerOS"). `GET <RESELLEROS_SERVER_URL>/api/public/hosting-prices` — public
 * list prices, so no key.
 *
 * A good answer is kept for 60 seconds so a busy panel does not ask on every request; a
 * failure is never kept, and there is no fallback table: when ResellerOS cannot be read the
 * outcome is `unavailable` and the caller shows no price (AGENTS.md §2).
 */
import { parseHostingPriceTable, type HostingPriceTable } from "@/lib/pricing/hosting-price";

export type HostingPricesOutcome =
  | { ok: true; table: HostingPriceTable }
  | { ok: false; detail: string };

export interface FetchHostingPricesOptions {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Tests pass a clock; the cache compares against it. */
  now?: () => number;
}

const TTL_MS = 60_000;
let cached: { at: number; base: string; table: HostingPriceTable } | null = null;

/** Tests only: forget the cached table. */
export function resetHostingPricesCache(): void {
  cached = null;
}

export async function fetchHostingPrices(options: FetchHostingPricesOptions = {}): Promise<HostingPricesOutcome> {
  const env = options.env ?? process.env;
  const raw = (env.RESELLEROS_SERVER_URL ?? "").trim();
  if (!/^https?:\/\//i.test(raw)) return { ok: false, detail: "RESELLEROS_SERVER_URL is not set on DMS" };
  const base = raw.replace(/\/+$/, "");
  const now = (options.now ?? Date.now)();
  if (cached && cached.base === base && now - cached.at < TTL_MS) return { ok: true, table: cached.table };

  let res: Response;
  try {
    res = await (options.fetchImpl ?? fetch)(`${base}/api/public/hosting-prices`, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
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
  const table = parseHostingPriceTable(body);
  if (!table) return { ok: false, detail: "ResellerOS's price list was incomplete or unreadable" };
  cached = { at: now, base, table };
  return { ok: true, table };
}

/** What the customer is told when prices cannot be shown (AGENTS.md §7). */
export const HOSTING_PRICES_UNAVAILABLE =
  "We couldn't load hosting prices just now, so nothing can be priced or bought here. " +
  "Our billing system didn't answer — please try again in a minute.";
