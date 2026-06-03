/**
 * Tests for `@/lib/tld-mappings` (rescan-4 slice 7fo). Static lookup
 * table mapping plain TLD ("com") → ResellerClub TLD-product-key
 * ("domcno"). Used by the pricing-cache to translate RC product codes
 * into customer-facing TLDs. Pins:
 *  - **Five `dom*` exceptions** (NOT `dot*`): com → 'domcno', org → 'domorg',
 *    info → 'dominfo', biz → 'dombiz', us → 'domus' — these are the
 *    historical RC product codes that DON'T follow the `dot{tld}` pattern.
 *    Any future "harmonisation" PR that flips them to `dotcom`/etc would
 *    silently break pricing lookups (the cache layer would miss every
 *    .com price), so they are pinned explicitly.
 *  - **`za` anomaly**: za → 'dotcoza' (NOT 'dotza'). The comment in source
 *    documents 'dotza was broken; dotcoza exists' — anti-regression pin
 *    so a future "consistency fix" can't revert it.
 *  - **`net` is the lone `dot*`** in the legacy big-gTLD set: net → 'dotnet'
 *    (so the exception list above is exactly those 5 — net is NOT one).
 *  - **The 13 commented-out 'Unsupported' ccTLDs** stay OUT of the map
 *    (lookup returns undefined): ua/ug/uy/uz/va/ve/vg/vi/vn/vu/wf/ye/yt/zm/zw.
 *  - **Value contract**: every value is a lowercase string with no leading
 *    dot, no whitespace, length >= 4 (the shortest is 'dotac' = 5).
 *  - **Spot-checks on common gTLDs / new gTLDs**: io → 'dotio', ai → 'dotai',
 *    dev → 'dotdev', app → 'dotapp', shop → 'dotshop', tech → 'dottech'.
 *  - **Spot-checks on ccTLDs**: in → 'dotin', co → 'dotco', uk → 'dotuk',
 *    de → 'dotde', jp → 'dotjp'.
 */
import { describe, it, expect } from "vitest";
import { tldMappings } from "@/lib/tld-mappings";

describe("tldMappings — special `dom*` exceptions (anti-regression)", () => {
  it.each([
    ["com", "domcno"],
    ["org", "domorg"],
    ["info", "dominfo"],
    ["biz", "dombiz"],
    ["us", "domus"],
  ])("%s → %s (NOT 'dot%s')", (tld, expected) => {
    expect(tldMappings[tld]).toBe(expected);
    expect(tldMappings[tld]).not.toBe(`dot${tld}`);
  });

  it("exactly 5 'dom*' exceptions exist (com/org/info/biz/us — net is NOT one)", () => {
    const domExceptions = Object.entries(tldMappings).filter(([, v]) =>
      v.startsWith("dom")
    );
    expect(domExceptions).toHaveLength(5);
    expect(tldMappings.net).toBe("dotnet"); // sentry: not 'domnet'
  });
});

describe("tldMappings — `za` anomaly anti-regression", () => {
  it("za → 'dotcoza' (NOT 'dotza' — source comment: dotza was broken, dotcoza exists)", () => {
    expect(tldMappings.za).toBe("dotcoza");
    expect(tldMappings.za).not.toBe("dotza");
  });
});

describe("tldMappings — unsupported ccTLDs stay OUT of the map", () => {
  it.each([
    "ua",
    "ug",
    "uy",
    "uz",
    "va",
    "ve",
    "vg",
    "vi",
    "vn",
    "vu",
    "wf",
    "ye",
    "yt",
    "zm",
    "zw",
  ])("%s → undefined (commented out as 'Unsupported')", (tld) => {
    expect(tldMappings[tld]).toBeUndefined();
  });
});

describe("tldMappings — common gTLDs spot-check", () => {
  it.each([
    ["io", "dotio"],
    ["ai", "dotai"],
    ["co", "dotco"],
    ["me", "dotme"],
    ["dev", "dotdev"],
    ["app", "dotapp"],
    ["shop", "dotshop"],
    ["tech", "dottech"],
    ["online", "dotonline"],
    ["site", "dotsite"],
    ["store", "dotstore"],
    ["xyz", undefined], // .xyz is NOT in this map (used elsewhere via different code path)
  ])("%s → %s", (tld, expected) => {
    expect(tldMappings[tld]).toBe(expected);
  });
});

describe("tldMappings — common ccTLDs spot-check", () => {
  it.each([
    ["in", "dotin"],
    ["uk", "dotuk"],
    ["de", "dotde"],
    ["fr", "dotfr"],
    ["es", "dotes"],
    ["nl", "dotnl"],
    ["jp", "dotjp"],
    ["cn", "dotcn"],
    ["br", "dotbr"],
    ["au", "dotau"],
    ["ca", "dotca"],
  ])("%s → %s", (tld, expected) => {
    expect(tldMappings[tld]).toBe(expected);
  });
});

describe("tldMappings — value contract", () => {
  it("every value is a lowercase string with no leading dot", () => {
    for (const [tld, value] of Object.entries(tldMappings)) {
      expect(value).toEqual(expect.any(String));
      expect(value).toBe(value.toLowerCase());
      expect(value.startsWith(".")).toBe(false);
      expect(value.length).toBeGreaterThanOrEqual(5); // shortest is 'dotac' = 5
      // info: tld is included in error context if a future addition violates this
      expect(value.includes(" ")).toBe(false);
      // marker — referenced for type narrowing on TS strict
      void tld;
    }
  });

  it("every key is a lowercase non-empty string", () => {
    for (const key of Object.keys(tldMappings)) {
      expect(key).toBe(key.toLowerCase());
      expect(key.length).toBeGreaterThan(0);
      expect(key.startsWith(".")).toBe(false);
    }
  });

  it("every value starts with 'dot' or 'dom' (the only two RC prefix shapes)", () => {
    for (const value of Object.values(tldMappings)) {
      const ok = value.startsWith("dot") || value.startsWith("dom");
      expect(ok).toBe(true);
    }
  });

  it("registry has at least 200 entries (massive ccTLD coverage)", () => {
    expect(Object.keys(tldMappings).length).toBeGreaterThanOrEqual(200);
  });
});
