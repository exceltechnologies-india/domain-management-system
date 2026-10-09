'use client';
/**
 * Fetch ResellerOS's per-term price for every domain in the cart that has not been asked
 * about yet, and return the price map so the page re-renders when an answer lands.
 * Used by the cart and checkout pages (9 Oct 2026).
 */
import { useEffect } from 'react';
import type { CartItem } from '@/lib/types';
import { useDomainTermPriceStore } from '@/store/domainTermPriceStore';

const asked = new Set<string>();

export function useDomainTermPrices(items: CartItem[]): Record<string, Record<string, number> | null> {
  const totals = useDomainTermPriceStore((s) => s.totals);
  const setTotals = useDomainTermPriceStore((s) => s.setTotals);
  const domains = items
    .filter((i) => (i.itemType ?? 'domain') === 'domain' && !i.isTrial)
    .map((i) => i.domainName.toLowerCase());
  const key = domains.join(',');

  useEffect(() => {
    for (const domain of key ? key.split(',') : []) {
      if (asked.has(domain)) continue;
      asked.add(domain);
      Promise.resolve()
        .then(() => fetch(`/api/public/domain-term-prices?domain=${encodeURIComponent(domain)}`, { cache: 'no-store' }))
        .then(async (res) => {
          const body = (await res?.json().catch(() => null)) as { state?: string; totals?: Record<string, number> } | null;
          setTotals(domain, res?.ok && body?.state === 'ok' && body.totals ? body.totals : null);
        })
        .catch(() => setTotals(domain, null))
        .finally(() => {
          // Let a later visit ask again (the server caches for 60 s).
          setTimeout(() => asked.delete(domain), 60_000);
        });
    }
  }, [key, setTotals]);

  return totals;
}
