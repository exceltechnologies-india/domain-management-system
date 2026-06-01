/**
 * Tests for `@/lib/domainRequirements` (rescan-4 slice 7ec).
 * TLD requirement/restriction registry. Pins:
 *  - RESTRICTED_TLDS is derived from TLD_POLICIES at module-load (any
 *    addition there shows up here — the source-of-truth pattern)
 *  - isRestrictedTLD accepts both `.com` AND `com` (callers come from
 *    DB rows that store TLDs in both shapes)
 *  - isRestrictedTLD is case-insensitive
 *  - getDomainRequirements has 4 pre-canned TLDs (.au/.co.uk/.ca/.de) +
 *    returns empty {requirements:[], restrictions:[]} for unknowns
 *  - generateAlternativeDomains excludes the input TLD from the
 *    5-common-TLD list (no `.com → .com` echo)
 *  - generateAlternativeDomains marks ALL as available:true (the call
 *    site is responsible for running an actual availability check —
 *    documented in the inline comment)
 *  - requiresSpecialVerification === requiresAdditionalDetails alias
 *  - isDomainSupported is the inverse of requiresSpecialVerification
 */
import { describe, it, expect } from "vitest";
import {
  RESTRICTED_TLDS,
  isRestrictedTLD,
  getDomainRequirements,
  generateAlternativeDomains,
  requiresSpecialVerification,
  requiresAdditionalDetails,
  isDomainSupported,
} from "@/lib/domainRequirements";

describe("RESTRICTED_TLDS / isRestrictedTLD", () => {
  it("RESTRICTED_TLDS is a non-empty list of dot-prefixed TLDs", () => {
    expect(Array.isArray(RESTRICTED_TLDS)).toBe(true);
    expect(RESTRICTED_TLDS.length).toBeGreaterThan(0);
    RESTRICTED_TLDS.forEach((tld) => expect(tld.startsWith(".")).toBe(true));
  });

  it("isRestrictedTLD accepts both `.com` AND `com` (dual-shape input)", () => {
    // Pick any restricted TLD from the registry to test both forms.
    const sample = RESTRICTED_TLDS[0]; // e.g. ".in"
    const withDot = sample;
    const noDot = sample.slice(1);
    expect(isRestrictedTLD(withDot)).toBe(true);
    expect(isRestrictedTLD(noDot)).toBe(true);
  });

  it("isRestrictedTLD is case-insensitive", () => {
    const sample = RESTRICTED_TLDS[0];
    const upper = sample.toUpperCase();
    expect(isRestrictedTLD(upper)).toBe(true);
  });

  it("returns false for a known-unrestricted TLD", () => {
    // .com is the canonical non-restricted TLD.
    expect(isRestrictedTLD(".com")).toBe(false);
    expect(isRestrictedTLD("com")).toBe(false);
  });

  it("returns false for an unknown TLD (registry miss → false, not throw)", () => {
    expect(isRestrictedTLD(".nonexistent-xyz")).toBe(false);
  });
});

describe("getDomainRequirements", () => {
  it("returns the canned 4-field shape for .au", () => {
    const result = getDomainRequirements(".au");
    expect(result.requirements.length).toBeGreaterThan(0);
    expect(result.restrictions.length).toBeGreaterThan(0);
    // .au requires ABN/ACN — the killer field.
    expect(result.requirements.some((r) => /ABN|ACN/.test(r.text))).toBe(true);
  });

  it("returns the canned shape for .co.uk, .ca, .de", () => {
    expect(getDomainRequirements(".co.uk").requirements.length).toBeGreaterThan(0);
    expect(getDomainRequirements(".ca").requirements.length).toBeGreaterThan(0);
    expect(getDomainRequirements(".de").requirements.length).toBeGreaterThan(0);
  });

  it("returns empty arrays for an unknown TLD (no fallthrough exception)", () => {
    const result = getDomainRequirements(".unknown");
    expect(result).toEqual({ requirements: [], restrictions: [] });
  });

  it("each restriction has a type in the allowed enum (warning/error/info)", () => {
    const result = getDomainRequirements(".au");
    const allowed = new Set(["warning", "error", "info"]);
    result.restrictions.forEach((r) => {
      expect(allowed.has(r.type)).toBe(true);
    });
  });
});

describe("generateAlternativeDomains", () => {
  it("excludes the input TLD from the 5-common-TLD output", () => {
    const alts = generateAlternativeDomains("example", ".com");
    // .com must NOT appear in the alternatives — that's the input.
    expect(alts.find((a) => a.domain === "example.com")).toBeUndefined();
    expect(alts.length).toBe(4); // 5 common TLDs minus the input
  });

  it("returns the 5 common TLDs minus the input — input=.org → 4 alts", () => {
    const alts = generateAlternativeDomains("example", ".org");
    expect(alts.map((a) => a.domain).sort()).toEqual(
      ["example.co", "example.com", "example.io", "example.net"].sort()
    );
  });

  it("input TLD that isn't in the common-5 list → all 5 alternatives returned", () => {
    const alts = generateAlternativeDomains("example", ".xyz");
    expect(alts.length).toBe(5);
  });

  it("marks all entries as available:true (responsibility deferred to caller)", () => {
    const alts = generateAlternativeDomains("example", ".com");
    alts.forEach((a) => expect(a.available).toBe(true));
  });

  it("each entry has a price string (caller-side cosmetic — defaults to .com price for unknowns)", () => {
    const alts = generateAlternativeDomains("example", ".xyz");
    alts.forEach((a) => expect(a.price).toMatch(/\$\d+\.\d{2}\/year/));
  });
});

describe("requiresSpecialVerification / requiresAdditionalDetails / isDomainSupported", () => {
  it("requiresSpecialVerification true for any TLD with canned requirements", () => {
    expect(requiresSpecialVerification(".au")).toBe(true);
    expect(requiresSpecialVerification(".co.uk")).toBe(true);
    expect(requiresSpecialVerification(".ca")).toBe(true);
    expect(requiresSpecialVerification(".de")).toBe(true);
  });

  it("requiresSpecialVerification false for unknown TLDs", () => {
    expect(requiresSpecialVerification(".com")).toBe(false);
    expect(requiresSpecialVerification(".unknown")).toBe(false);
  });

  it("requiresAdditionalDetails is the same function (backwards-compat alias)", () => {
    expect(requiresAdditionalDetails).toBe(requiresSpecialVerification);
  });

  it("isDomainSupported is the inverse of requiresSpecialVerification", () => {
    expect(isDomainSupported(".com")).toBe(true);
    expect(isDomainSupported(".au")).toBe(false);
  });
});
