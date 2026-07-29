import { describe, it, expect } from "vitest";
import {
  isProvisionableDomain,
  hostingItemDomain,
} from "@/lib/validation/hosting-domain";

describe("isProvisionableDomain", () => {
  it("accepts ordinary domains", () => {
    for (const d of [
      "example.com",
      "my-site.co.in",
      "sub.domain.example.org",
      "a1.io",
      "xn--h2brj9c.in", // IDN label
      "example.xn--p1ai", // IDN TLD
    ]) {
      expect(isProvisionableDomain(d), d).toBe(true);
    }
  });

  it("accepts real domains that start with 'hosting-' (no false reject)", () => {
    // The old `startsWith("hosting-")` guard wrongly rejected these.
    expect(isProvisionableDomain("hosting-guru.com")).toBe(true);
    expect(isProvisionableDomain("hosting-24.net")).toBe(true);
  });

  it("trims + lowercases before validating", () => {
    expect(isProvisionableDomain("  Example.COM  ")).toBe(true);
  });

  it("rejects the synthetic hosting placeholder (no dot)", () => {
    // Exactly what components/marketing/HostingLanding.tsx generates.
    expect(isProvisionableDomain(`hosting-plus-${Date.now()}`)).toBe(false);
    expect(isProvisionableDomain("hosting-starter-1785303670791")).toBe(false);
  });

  it("rejects empty / whitespace / non-string", () => {
    for (const v of ["", "   ", null, undefined, 42, {}, []]) {
      expect(isProvisionableDomain(v as unknown)).toBe(false);
    }
  });

  it("rejects malformed hostnames the old dot-check let through", () => {
    for (const d of [
      ".com",
      "a.",
      "x. y",
      "example .com",
      "-bad.com",
      "bad-.com",
      "localhost",
      "http://example.com",
      "example.com/path",
      "example..com",
      "exa mple.com",
    ]) {
      expect(isProvisionableDomain(d), d).toBe(false);
    }
  });
});

describe("hostingItemDomain", () => {
  it("prefers linkedDomain over domainName", () => {
    expect(
      hostingItemDomain({ linkedDomain: "Linked.com", domainName: "host-x" })
    ).toBe("linked.com");
  });

  it("falls back to domainName when no linkedDomain", () => {
    expect(hostingItemDomain({ domainName: "Fallback.COM" })).toBe(
      "fallback.com"
    );
  });

  it("returns '' when neither present or non-string", () => {
    expect(hostingItemDomain({})).toBe("");
    expect(
      hostingItemDomain({ linkedDomain: 5 as unknown as string })
    ).toBe("");
  });
});
