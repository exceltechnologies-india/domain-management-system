/**
 * Central TLD policy registry — single source of truth for per-TLD constraints.
 *
 * Consulted by:
 *  - lib/tld-min-periods.ts        → year clamping in cart/checkout/UI
 *  - lib/domainRequirements.ts     → restricted-TLD blocking in search
 *  - lib/resellerclub.ts           → policy-specific params on registerDomain
 *  - app/api/cart/route.ts         → server-side cart correction
 *  - app/api/payments/create-order → pre-payment guard
 */

/**
 * A user-collected attribute that ResellerClub requires for some TLDs
 * (e.g. .us Nexus category, .eu country of residence, .pro profession).
 *
 * `attrName` is what we pass to RC as `attr-name1` / `attr-value1`.
 * `field` is the form field shown to the user at checkout.
 */
export interface TldAttributeSchema {
  attrName: string;          // e.g. "purpose"   (RC param key)
  field: string;             // e.g. "usNexusCategory"  (our internal key)
  label: string;             // shown to user
  description?: string;
  type: "select" | "text";
  options?: { value: string; label: string }[];
  required: boolean;
}

export interface TldPolicy {
  /** Minimum registration period in years. Default 1. */
  minYears?: number;
  /** Maximum registration period in years. Default 10. */
  maxYears?: number;
  /**
   * If true, ResellerClub requires `attribute-name=acceptTerms / attribute-value=1`
   * on the register call. Without this many new gTLDs return
   * "Please accept the Terms & Conditions".
   */
  acceptTerms?: boolean;
  /**
   * Restricted = we don't fulfil this TLD (registrant must have local
   * presence we can't satisfy). Search hides them, cart rejects them.
   */
  restricted?: boolean;
  /**
   * Optional human-facing requirements list (display only). The
   * underlying enforcement comes from `restricted` + RC's own validation.
   */
  requirements?: string[];
  /**
   * Attributes the user must provide at checkout (e.g. Nexus for .us).
   * Empty/undefined for the common case.
   */
  requiredAttributes?: TldAttributeSchema[];
}

/**
 * Registry — keyed by TLD WITHOUT leading dot. Use lower-case.
 * Multi-level TLDs are stored as full (e.g. "co.uk", "co.in").
 */
export const TLD_POLICIES: Record<string, TldPolicy> = {
  // ── Big gTLDs ─────────────────────────────────────────────────────────────
  com:  { minYears: 1, maxYears: 10 },
  net:  { minYears: 1, maxYears: 10 },
  org:  { minYears: 1, maxYears: 10 },
  info: { minYears: 1, maxYears: 10 },
  biz:  { minYears: 1, maxYears: 10 },
  xyz:  { minYears: 1, maxYears: 10 },
  me:   { minYears: 1, maxYears: 10 },

  // ── Restrictive new gTLDs (need T&C acceptance) ───────────────────────────
  dev:     { minYears: 1, maxYears: 10, acceptTerms: true },
  app:     { minYears: 1, maxYears: 10, acceptTerms: true },
  page:    { minYears: 1, maxYears: 10, acceptTerms: true },
  new:     { minYears: 1, maxYears: 10, acceptTerms: true },
  how:     { minYears: 1, maxYears: 10, acceptTerms: true },
  soy:     { minYears: 1, maxYears: 10, acceptTerms: true },
  rsvp:    { minYears: 1, maxYears: 10, acceptTerms: true },
  zip:     { minYears: 1, maxYears: 10, acceptTerms: true },
  mov:     { minYears: 1, maxYears: 10, acceptTerms: true },
  foo:     { minYears: 1, maxYears: 10, acceptTerms: true },
  esq:     { minYears: 1, maxYears: 10, acceptTerms: true },
  prof:    { minYears: 1, maxYears: 10, acceptTerms: true },
  phd:     { minYears: 1, maxYears: 10, acceptTerms: true },
  nexus:   { minYears: 1, maxYears: 10, acceptTerms: true },
  shop:    { minYears: 1, maxYears: 10, acceptTerms: true },
  store:   { minYears: 1, maxYears: 10, acceptTerms: true },
  online:  { minYears: 1, maxYears: 10, acceptTerms: true },
  site:    { minYears: 1, maxYears: 10, acceptTerms: true },
  tech:    { minYears: 1, maxYears: 10, acceptTerms: true },
  space:   { minYears: 1, maxYears: 10, acceptTerms: true },
  website: { minYears: 1, maxYears: 10, acceptTerms: true },

  // ── Long-minimum gTLDs ────────────────────────────────────────────────────
  ai: { minYears: 2, maxYears: 10, acceptTerms: true },
  io: { minYears: 1, maxYears: 10, acceptTerms: true },
  co: { minYears: 1, maxYears: 5 },

  // ── India-friendly ccTLDs (allowed — RC handles defaults) ─────────────────
  in:        { minYears: 1, maxYears: 10 },
  "co.in":   { minYears: 1, maxYears: 10 },
  "net.in":  { minYears: 1, maxYears: 10 },
  "org.in":  { minYears: 1, maxYears: 10 },
  "firm.in": { minYears: 1, maxYears: 10 },
  "gen.in":  { minYears: 1, maxYears: 10 },
  "ind.in":  { minYears: 1, maxYears: 10 },
  bharat:    { minYears: 1, maxYears: 10, requirements: ["Indian registrant contact required"] },

  // ── Restricted ccTLDs (we don't fulfil — local presence required) ─────────
  au:       { restricted: true, requirements: ["Australian ABN/ACN required"] },
  uk:       { restricted: true, requirements: ["UK presence required"] },
  "co.uk":  { restricted: true, requirements: ["UK presence required"] },
  ca:       { restricted: true, requirements: ["Canadian Presence Requirements (CIRA)"] },
  de:       { restricted: true, requirements: ["German address required"] },
  fr:       { restricted: true, requirements: ["EU presence required"] },
  nl:       { restricted: true, requirements: ["EU presence required"] },
  es:       { restricted: true, requirements: ["Spanish ID required"] },
  it:       { restricted: true, requirements: ["EU presence required"] },
  jp:       { restricted: true, requirements: ["Japanese presence required"] },
  cn:       { restricted: true, requirements: ["Chinese real-name verification required"] },
  br:       { restricted: true, requirements: ["Brazilian CPF/CNPJ required"] },
  mx:       { restricted: true, requirements: ["Mexican presence required"] },
  ru:       { restricted: true, requirements: ["Russian passport required"] },
  za:       { restricted: true, requirements: ["South African presence required"] },
};

/**
 * Default policy values applied when a TLD isn't in the registry.
 * Used so we don't have to enumerate every long-tail TLD.
 */
const DEFAULTS: Required<Pick<TldPolicy, "minYears" | "maxYears">> = {
  minYears: 1,
  maxYears: 10,
};

/** Extract the TLD from a domain name, lower-cased and without leading dot. */
export function extractTld(domainName: string): string {
  const parts = domainName.toLowerCase().trim().split(".");
  if (parts.length < 2) return "";
  // Prefer multi-level match (e.g. "co.uk", "co.in") before single
  if (parts.length >= 3) {
    const twoLevel = parts.slice(-2).join(".");
    if (TLD_POLICIES[twoLevel]) return twoLevel;
  }
  return parts[parts.length - 1];
}

/** Look up policy for a domain (returns defaults merged with any overrides). */
export function getTldPolicy(domainName: string): Required<Pick<TldPolicy, "minYears" | "maxYears">> & TldPolicy {
  const tld = extractTld(domainName);
  const policy = TLD_POLICIES[tld] ?? {};
  return { ...DEFAULTS, ...policy };
}

export function getMinYears(domainName: string): number {
  return getTldPolicy(domainName).minYears;
}

export function getMaxYears(domainName: string): number {
  return getTldPolicy(domainName).maxYears;
}

export function isRestricted(domainName: string): boolean {
  return getTldPolicy(domainName).restricted === true;
}

/**
 * Validate a (domain, period) pair against the registry.
 * Returns null if valid, or an error message describing what's wrong.
 */
export function validateDomainPeriod(
  domainName: string,
  registrationPeriod: number
): string | null {
  const policy = getTldPolicy(domainName);
  if (policy.restricted) {
    return `${domainName} requires local presence we can't fulfil — please choose a different TLD.`;
  }
  if (registrationPeriod < policy.minYears) {
    return `${domainName} requires a minimum registration of ${policy.minYears} year${policy.minYears > 1 ? "s" : ""}.`;
  }
  if (registrationPeriod > policy.maxYears) {
    return `${domainName} can be registered for at most ${policy.maxYears} years.`;
  }
  return null;
}

/**
 * Build the extra URLSearchParams entries required by ResellerClub for this TLD.
 * Returns an array of [key, value] tuples so callers can use `.append()`.
 *
 * `userAttributes` — key/value map of `TldAttributeSchema.field → user value`.
 * Required schema entries that are missing from `userAttributes` are skipped
 * silently here — `getMissingAttributes()` is the right place to enforce.
 */
export function getRegistrationParamPairs(
  domainName: string,
  userAttributes?: Record<string, string>
): Array<[string, string]> {
  const policy = getTldPolicy(domainName);
  const pairs: Array<[string, string]> = [];

  // Static attribute: T&C acceptance for new gTLDs
  if (policy.acceptTerms) {
    pairs.push(["attribute-name", "acceptTerms"]);
    pairs.push(["attribute-value", "1"]);
  }

  // Dynamic attributes provided by the user at checkout (Nexus, CED, etc.)
  // ResellerClub expects numbered attr-name1/attr-value1, attr-name2/attr-value2.
  if (policy.requiredAttributes?.length) {
    let i = 1;
    for (const schema of policy.requiredAttributes) {
      const v = userAttributes?.[schema.field];
      if (v === undefined || v === null || v === "") continue;
      pairs.push([`attr-name${i}`, schema.attrName]);
      pairs.push([`attr-value${i}`, String(v)]);
      i++;
    }
  }

  return pairs;
}

/** Return required attribute schemas for a domain (empty if none). */
export function getRequiredAttributes(domainName: string): TldAttributeSchema[] {
  return getTldPolicy(domainName).requiredAttributes ?? [];
}

/**
 * Given a cart, return which domains still need user input for their
 * required attributes. Each entry: { domainName, missing: TldAttributeSchema[] }.
 */
export function getMissingAttributes(
  cart: Array<{ domainName: string; tldAttributes?: Record<string, string> }>
): Array<{ domainName: string; missing: TldAttributeSchema[] }> {
  const result: Array<{ domainName: string; missing: TldAttributeSchema[] }> = [];
  for (const item of cart) {
    if (!item?.domainName) continue;
    const schemas = getRequiredAttributes(item.domainName).filter(s => s.required);
    if (schemas.length === 0) continue;
    const missing = schemas.filter(s => {
      const v = item.tldAttributes?.[s.field];
      return v === undefined || v === null || v === "";
    });
    if (missing.length > 0) result.push({ domainName: item.domainName, missing });
  }
  return result;
}

/**
 * Map a raw ResellerClub error string to a user-friendly explanation.
 * Returns null if the error is not a known policy/registry case.
 */
export function mapRegistrationError(rawError: string): string | null {
  if (!rawError) return null;
  const err = rawError.toLowerCase();

  if (err.includes("terms") && err.includes("condition")) {
    return "Domain registry requires terms & conditions acceptance. Please contact support.";
  }
  if (err.includes("minimum") && err.includes("period")) {
    return "This TLD has a minimum registration period that wasn't met. Please increase the duration in your cart.";
  }
  if (err.includes("eligibility") || err.includes("presence requirement")) {
    return "Your account doesn't meet the registry's eligibility requirements for this TLD.";
  }
  if (err.includes("contact") && err.includes("invalid")) {
    return "The registry rejected the contact details — please update your address and phone in Settings.";
  }
  if (err.includes("premium")) {
    return "This is a premium domain. Premium pricing is not supported via standard checkout — please contact support.";
  }
  if (err.includes("not available") || err.includes("unavailable")) {
    return "This domain is no longer available. Someone may have registered it in the last few seconds.";
  }
  return null;
}
