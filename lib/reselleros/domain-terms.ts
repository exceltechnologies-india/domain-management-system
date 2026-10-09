/**
 * The registration terms a domain can be bought for — the ones ResellerOS sells and prices
 * (its `DOMAIN_TERMS` in lib/domains/live-lookup.ts, R-156: 1, 2, 3 or 5 years).
 *
 * The portal cart used to offer every term from the TLD minimum to 10 years. A customer who
 * picked 4 years reached checkout and was refused there ("a 4-year price couldn't be
 * confirmed") — the registry prices it, but ResellerOS does not sell it. The picker now offers
 * only these, and the cart moves a stored term onto one of them (9 Oct 2026).
 */
export const RESELLEROS_DOMAIN_TERMS: readonly number[] = [1, 2, 3, 5];

/** The terms to offer for a domain whose TLD needs at least `minYears`. */
export function domainTermOptions(minYears = 1): number[] {
  const terms = RESELLEROS_DOMAIN_TERMS.filter((t) => t >= minYears);
  return terms.length ? terms : [minYears];
}

/** A stored term moved onto an offered one: the longest offered term not above it, else the shortest. */
export function nearestDomainTerm(years: number, minYears = 1): number {
  const options = domainTermOptions(minYears);
  const below = options.filter((t) => t <= years);
  return below.length ? below[below.length - 1] : options[0];
}

/**
 * A domain cart line's term in years. The picker labels its options "N Years" but used to save
 * them with periodUnit "months", so "3" with "months" means 3 years; only a whole number of
 * years written as months (12, 24, …) is read as months.
 */
export function domainYearsOf(item: { registrationPeriod?: number; periodUnit?: string }): number {
  const period = item.registrationPeriod ?? 1;
  if (item.periodUnit === "months" && period >= 12 && period % 12 === 0) return period / 12;
  return period;
}
