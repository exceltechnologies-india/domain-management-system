/**
 * Pure cart-item validation helpers. Extracted from `store/cartStore.ts`
 * (rescan-4 M14 slice 15) so they can be unit-tested without the
 * surrounding zustand store, persistence, and toast side-effects.
 *
 * Two helpers:
 *
 *  - `clampRegistrationPeriod` — figures the [min, max] window for the
 *    given TLD / hosting context and clamps the incoming period into
 *    it. Called by `addItem` at add time.
 *
 *  - `validateAndCorrectCartItems` — runs the same normalisation across
 *    an entire item list, plus the back-fix for the legacy hosting-10
 *    bug, plus dedup-by-(domainName, itemType) merging duplicate
 *    entries. Called by `syncWithServer` after the local/server merge
 *    to give the final cart a single normalisation pass.
 */
import type { CartItem } from "@/lib/types";
import { getMinRegistrationPeriod } from "@/lib/tld-min-periods";
import { getMaxYears } from "@/lib/tld-policies";

/**
 * Periods for hosting items use `registrationPeriod` as a unit-less
 * count paired with `periodUnit`:
 *   - monthly:  1   (months)
 *   - yearly:  12   (months)
 *   - trial:   15   (days)
 *   - test:    10   (minutes)
 * 60 is generous — the longest realistic period is yearly × multi-year
 * promos. The 10-year domain cap doesn't apply here.
 */
const HOSTING_MAX_PERIOD = 60;

export interface ClampOptions {
  domainName: string;
  itemType?: "domain" | "hosting";
  registrationPeriod: number;
}

export function clampRegistrationPeriod(opts: ClampOptions): number {
  const minPeriod =
    opts.itemType === "hosting"
      ? 1
      : getMinRegistrationPeriod(opts.domainName);
  const maxPeriod =
    opts.itemType === "hosting" ? HOSTING_MAX_PERIOD : getMaxYears(opts.domainName);
  return Math.min(Math.max(opts.registrationPeriod, minPeriod), maxPeriod);
}

/**
 * Validate + dedup a cart item list. Three concerns folded into one
 * pass:
 *
 *  1. Normalise missing `itemType` to "domain".
 *  2. Floor `registrationPeriod` at the TLD min (hosting min = 1).
 *     Note this floors but does NOT cap to the TLD max — that's
 *     `clampRegistrationPeriod`'s job at add time. The list-level pass
 *     only floors because the existing data on a Hosting row may have
 *     been written under an older max policy; we don't want to
 *     retroactively clamp.
 *  3. Back-fix legacy hosting carts where `registrationPeriod=10` for
 *     `billingCycle=yearly` items got there via an earlier clamp bug
 *     (the 10-year domain default leaked into the hosting branch).
 *     Snap those to 12 (yearly = 12 months).
 *  4. Dedup by `(domainName, itemType)` — later entries override
 *     earlier ones via shallow spread.
 */
export function validateAndCorrectCartItems(items: CartItem[]): CartItem[] {
  const seen = new Map<string, CartItem>();

  items.forEach((item) => {
    const itemType = item.itemType || "domain";

    const minPeriod =
      itemType === "hosting" ? 1 : getMinRegistrationPeriod(item.domainName);
    let registrationPeriod = Math.max(item.registrationPeriod || 1, minPeriod);

    if (
      itemType === "hosting" &&
      item.billingCycle === "yearly" &&
      registrationPeriod === 10
    ) {
      registrationPeriod = 12;
    }

    const validatedItem: CartItem = {
      ...item,
      itemType: itemType as "domain" | "hosting",
      registrationPeriod,
    };

    const key = `${validatedItem.domainName}-${itemType}`;
    if (seen.has(key)) {
      const existing = seen.get(key)!;
      seen.set(key, { ...existing, ...validatedItem });
    } else {
      seen.set(key, validatedItem);
    }
  });

  return Array.from(seen.values());
}
