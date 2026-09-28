'use client';

/**
 * ResellerOS's hosting prices in the browser (owner, 28 Sep 2026: read live, keep no copy).
 *
 * Three states, and a component must handle all of them: `loading`, `ok` with the table, and
 * `unavailable` with a sentence to show. There is no fallback table — an unreadable answer is
 * `unavailable`, never a guessed price (AGENTS.md §2).
 */
import useSWR from 'swr';
import { parseHostingPriceTable, type HostingPriceTable } from '@/lib/pricing/hosting-price';

export type HostingPricesState =
  | { state: 'loading' }
  | { state: 'ok'; table: HostingPriceTable }
  | { state: 'unavailable'; message: string };

const FALLBACK_MESSAGE =
  "We couldn't load hosting prices just now, so nothing can be priced or bought here. Please try again in a minute.";

async function load(url: string): Promise<HostingPricesState> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } });
  } catch {
    return { state: 'unavailable', message: FALLBACK_MESSAGE };
  }
  let body: { state?: string; table?: unknown; message?: unknown } | null = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.ok && body?.state === 'ok') {
    const table = parseHostingPriceTable(body.table);
    if (table) return { state: 'ok', table };
  }
  return { state: 'unavailable', message: typeof body?.message === 'string' ? body.message : FALLBACK_MESSAGE };
}

export function useHostingPrices(): HostingPricesState {
  const { data } = useSWR('/api/v1/public/hosting-prices', load, { revalidateOnFocus: false, dedupingInterval: 60_000 });
  return data ?? { state: 'loading' };
}
