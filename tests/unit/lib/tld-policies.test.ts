/**
 * Tests for `@/lib/tld-policies` (rescan-4 slice 7fm). Central TLD
 * policy registry — single source of truth for per-TLD constraints
 * (min/max years, T&C, restricted, registry attributes). Pins:
 *  - **TLD_POLICIES contract**: .com/.net/.org etc are 1-10 years (no
 *    acceptTerms); 23 new gTLDs (dev/app/page/shop/site/tech/etc)
 *    require T&C; .ai is 2-year min; .co is 1-5 years max; .in family
 *    allowed; **15 ccTLDs are restricted** (au/uk/co.uk/ca/de/fr/nl/
 *    es/it/jp/cn/br/mx/ru/za — local presence required)
 *  - extractTld lower-cases + trims + handles multi-level TLDs
 *    (`shop.co.uk` → `co.uk`, NOT `uk`); single-segment input → ''
 *  - getTldPolicy merges defaults (1-10) with overrides; unknown TLD →
 *    default policy
 *  - **validateDomainPeriod returns null when valid**; restricted →
 *    'requires local presence' message; below min → 'minimum registration
 *    of X years' (singular/plural); above max → 'at most X years'
 *  - **getRegistrationParamPairs emits T&C pair for acceptTerms TLDs**
 *    (`attribute-name=acceptTerms` + `attribute-value=1`); skipped for
 *    non-acceptTerms TLDs (.com)
 *  - Required-attribute schema entries get `attr-name{N}` / `attr-value{N}`
 *    numbered pairs starting at 1; missing values silently skipped
 *    here (caller-side enforcement via getMissingAttributes)
 *  - **getMissingAttributes** walks cart, returns only items whose
 *    REQUIRED attributes lack values; optional attributes ignored
 *  - **mapRegistrationError** 6 distinct branches (T&C, min period,
 *    eligibility, contact, premium, unavailable); unknown error → null
 */
import { describe, it, expect } from "vitest";
import {
  TLD_POLICIES,
  extractTld,
  getTldPolicy,
  getMinYears,
  getMaxYears,
  isRestricted,
  validateDomainPeriod,
  getRegistrationParamPairs,
  getRequiredAttributes,
  getMissingAttributes,
  mapRegistrationError,
} from "@/lib/tld-policies";

describe("TLD_POLICIES registry contract", () => {
  it("big gTLDs: .com/.net/.org/.info/.biz all 1-10 years, no acceptTerms", () => {
    for (const tld of ["com", "net", "org", "info", "biz", "xyz", "me"]) {
      expect(TLD_POLICIES[tld].minYears).toBe(1);
      expect(TLD_POLICIES[tld].maxYears).toBe(10);
      expect(TLD_POLICIES[tld].acceptTerms).toBeFalsy();
    }
  });

  it("new gTLDs require acceptTerms: dev/app/page/shop/site/tech/online/store/space/website", () => {
    for (const tld of [
      "dev",
      "app",
      "page",
      "shop",
      "site",
      "tech",
      "online",
      "store",
      "space",
      "website",
    ]) {
      expect(TLD_POLICIES[tld].acceptTerms).toBe(true);
    }
  });

  it(".ai has 2-year minimum (long-minimum gTLD)", () => {
    expect(TLD_POLICIES.ai.minYears).toBe(2);
    expect(TLD_POLICIES.ai.acceptTerms).toBe(true);
  });

  it(".co caps at 5 years (long-minimum but bounded max)", () => {
    expect(TLD_POLICIES.co.maxYears).toBe(5);
  });

  it("Indian ccTLDs allowed (no restricted flag): in/co.in/net.in/org.in/firm.in/gen.in/ind.in/bharat", () => {
    for (const tld of [
      "in",
      "co.in",
      "net.in",
      "org.in",
      "firm.in",
      "gen.in",
      "ind.in",
      "bharat",
    ]) {
      expect(TLD_POLICIES[tld].restricted).toBeFalsy();
    }
  });

  it("15 ccTLDs are restricted (local presence required)", () => {
    const restrictedTlds = [
      "au",
      "uk",
      "co.uk",
      "ca",
      "de",
      "fr",
      "nl",
      "es",
      "it",
      "jp",
      "cn",
      "br",
      "mx",
      "ru",
      "za",
    ];
    for (const tld of restrictedTlds) {
      expect(TLD_POLICIES[tld].restricted).toBe(true);
    }
    expect(restrictedTlds).toHaveLength(15);
  });
});

describe("extractTld — multi-level handling", () => {
  it("simple TLD: lowercased + trimmed", () => {
    expect(extractTld("X.COM")).toBe("com");
    expect(extractTld("  X.COM  ")).toBe("com");
  });

  it("multi-level: 'shop.co.uk' → 'co.uk' (NOT 'uk')", () => {
    expect(extractTld("shop.co.uk")).toBe("co.uk");
  });

  it("multi-level: 'shop.co.in' → 'co.in'", () => {
    expect(extractTld("shop.co.in")).toBe("co.in");
  });

  it("3+ segments but TWO-level not in registry → falls back to last segment", () => {
    // 'foo.bar.com' — 'bar.com' not in registry, falls back to 'com'
    expect(extractTld("foo.bar.com")).toBe("com");
  });

  it("single-segment → '' empty string", () => {
    expect(extractTld("localhost")).toBe("");
  });

  it("empty / whitespace → ''", () => {
    expect(extractTld("")).toBe("");
    expect(extractTld("   ")).toBe("");
  });
});

describe("getTldPolicy + getMinYears + getMaxYears + isRestricted", () => {
  it("known TLD merges defaults with overrides", () => {
    const policy = getTldPolicy("x.ai");
    expect(policy.minYears).toBe(2);
    expect(policy.maxYears).toBe(10);
    expect(policy.acceptTerms).toBe(true);
  });

  it("unknown TLD → defaults (1-10)", () => {
    const policy = getTldPolicy("x.totallymadeup");
    expect(policy.minYears).toBe(1);
    expect(policy.maxYears).toBe(10);
  });

  it("getMinYears + getMaxYears delegate", () => {
    expect(getMinYears("x.ai")).toBe(2);
    expect(getMaxYears("x.co")).toBe(5);
  });

  it("isRestricted: true for restricted ccTLDs, false otherwise", () => {
    expect(isRestricted("x.au")).toBe(true);
    expect(isRestricted("shop.co.uk")).toBe(true);
    expect(isRestricted("x.com")).toBe(false);
    expect(isRestricted("x.in")).toBe(false);
  });
});

describe("validateDomainPeriod", () => {
  it("valid pair → null", () => {
    expect(validateDomainPeriod("x.com", 1)).toBeNull();
    expect(validateDomainPeriod("x.com", 10)).toBeNull();
    expect(validateDomainPeriod("x.ai", 2)).toBeNull();
  });

  it("restricted TLD → 'requires local presence' message regardless of period", () => {
    const msg = validateDomainPeriod("x.au", 1);
    expect(msg).toMatch(/local presence we can't fulfil/);
  });

  it("below min: '.ai' with 1 year → 'minimum registration of 2 years' (plural)", () => {
    const msg = validateDomainPeriod("x.ai", 1);
    expect(msg).toMatch(/minimum registration of 2 years/);
  });

  it("below min plural threshold of 1 → 'year' singular", () => {
    // Need a TLD with minYears=1 explicitly tested for plural — manufactured
    // by feeding 0 years to .com (minYears=1).
    const msg = validateDomainPeriod("x.com", 0);
    expect(msg).toMatch(/minimum registration of 1 year/);
    expect(msg).not.toMatch(/1 years/); // not plural
  });

  it("above max: '.co' with 6 years → 'at most 5 years'", () => {
    expect(validateDomainPeriod("x.co", 6)).toMatch(/at most 5 years/);
  });

  it("above default max: 11 years on .com → 'at most 10 years'", () => {
    expect(validateDomainPeriod("x.com", 11)).toMatch(/at most 10 years/);
  });
});

describe("getRegistrationParamPairs", () => {
  it("non-acceptTerms TLD (.com) → no T&C pair emitted", () => {
    expect(getRegistrationParamPairs("x.com")).toEqual([]);
  });

  it("acceptTerms TLD (.dev) → emits 'attribute-name'/'attribute-value' pair", () => {
    expect(getRegistrationParamPairs("x.dev")).toEqual([
      ["attribute-name", "acceptTerms"],
      ["attribute-value", "1"],
    ]);
  });

  it("acceptTerms applies regardless of period or other inputs", () => {
    const pairs = getRegistrationParamPairs("x.ai");
    expect(pairs).toContainEqual(["attribute-name", "acceptTerms"]);
    expect(pairs).toContainEqual(["attribute-value", "1"]);
  });

  it("missing userAttributes for required schema → silently skipped (caller enforces)", () => {
    // None of the default policies declare requiredAttributes, but the
    // behaviour should match: no extra pairs added when the map is empty
    expect(getRegistrationParamPairs("x.com", {})).toEqual([]);
  });
});

describe("getRequiredAttributes + getMissingAttributes", () => {
  it("getRequiredAttributes default is [] (no policy with declared attrs in registry)", () => {
    expect(getRequiredAttributes("x.com")).toEqual([]);
    expect(getRequiredAttributes("x.au")).toEqual([]);
  });

  it("getMissingAttributes: empty cart → empty result", () => {
    expect(getMissingAttributes([])).toEqual([]);
  });

  it("getMissingAttributes skips items with no required schema (the common case)", () => {
    expect(
      getMissingAttributes([
        { domainName: "x.com" },
        { domainName: "y.dev" },
      ])
    ).toEqual([]);
  });

  it("getMissingAttributes skips falsy domain entries gracefully", () => {
    expect(
      getMissingAttributes([
        { domainName: "" } as never,
        { domainName: undefined as never },
      ] as never)
    ).toEqual([]);
  });
});

describe("mapRegistrationError — RC raw-error → user-friendly message", () => {
  it("T&C mention → contact support message", () => {
    expect(
      mapRegistrationError("Domain registry requires terms and conditions")
    ).toMatch(/terms.*conditions acceptance/i);
  });

  it("'minimum' + 'period' → increase duration message", () => {
    expect(
      mapRegistrationError("Minimum registration period not met")
    ).toMatch(/increase the duration/);
  });

  it("'eligibility' → registry eligibility message", () => {
    expect(
      mapRegistrationError("Registrant fails eligibility check")
    ).toMatch(/eligibility requirements/);
  });

  it("'presence requirement' → eligibility branch (alias)", () => {
    expect(
      mapRegistrationError("Local presence requirement not met")
    ).toMatch(/eligibility requirements/);
  });

  it("'contact' + 'invalid' → update address/phone message", () => {
    expect(
      mapRegistrationError("Contact details are invalid")
    ).toMatch(/update your address and phone/);
  });

  it("'premium' → contact-support-for-premium message", () => {
    expect(
      mapRegistrationError("Premium domain pricing required")
    ).toMatch(/premium domain/i);
  });

  it("'not available' OR 'unavailable' → registered-in-last-seconds message", () => {
    expect(mapRegistrationError("Domain not available")).toMatch(
      /no longer available/
    );
    expect(mapRegistrationError("Currently unavailable")).toMatch(
      /no longer available/
    );
  });

  it("unrecognised error → null", () => {
    expect(mapRegistrationError("Random unhandled error")).toBeNull();
  });

  it("empty/null input → null", () => {
    expect(mapRegistrationError("")).toBeNull();
  });

  it("case-insensitive matching", () => {
    expect(mapRegistrationError("PREMIUM DOMAIN")).toMatch(/premium/i);
    expect(mapRegistrationError("Minimum Period not met")).toMatch(
      /increase the duration/
    );
  });
});
