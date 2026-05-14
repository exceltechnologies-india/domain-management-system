/**
 * Thin wrapper around the central TLD policy registry.
 * Kept for backward compatibility — new code should import from `lib/tld-policies`.
 */
import { TLD_POLICIES, getMinYears } from "./tld-policies";

export const TLD_MIN_PERIODS: Record<string, number> = Object.fromEntries(
  Object.entries(TLD_POLICIES)
    .filter(([, p]) => typeof p.minYears === "number" && p.minYears! > 1)
    .map(([tld, p]) => [tld, p.minYears!])
);

export function getMinRegistrationPeriod(domainName: string): number {
  return getMinYears(domainName);
}
