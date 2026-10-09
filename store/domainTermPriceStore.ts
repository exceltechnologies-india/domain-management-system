/**
 * ResellerOS's per-term domain prices, as fetched for the portal cart (9 Oct 2026). Kept apart
 * from the cart store on purpose: the cart is saved to the account and synced, and a price is
 * not part of what the customer chose — it is re-read every visit (and cached 60 s server-side).
 *
 * `null` = asked and ResellerOS could not answer; absent = not asked yet.
 */
import { create } from "zustand";

interface DomainTermPriceState {
  totals: Record<string, Record<string, number> | null>;
  setTotals: (domain: string, totals: Record<string, number> | null) => void;
}

export const useDomainTermPriceStore = create<DomainTermPriceState>()((set) => ({
  totals: {},
  setTotals: (domain, totals) => set((s) => ({ totals: { ...s.totals, [domain.toLowerCase()]: totals } })),
}));

/** The totals for one domain, or undefined while not known. */
export function termTotalsFor(domain: string): Record<string, number> | undefined {
  return useDomainTermPriceStore.getState().totals[domain.toLowerCase()] ?? undefined;
}
