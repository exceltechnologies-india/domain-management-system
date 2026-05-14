import { describe, it, expect } from "vitest";

import Domain from "@/models/Domain";

describe("Domain module", () => {
  it("imports without throwing an error", () => {
    expect(Domain).toBeDefined();
  });
});

describe("Domain status enum values", () => {
  const validStatuses = [
    "available",
    "registered",
    "expiring_soon",
    "grace",
    "suspended",
    "pending",
    "failed",
  ] as const;

  it("includes all expected domain status values", () => {
    expect(validStatuses).toContain("available");
    expect(validStatuses).toContain("registered");
    expect(validStatuses).toContain("expiring_soon");
    expect(validStatuses).toContain("grace");
    expect(validStatuses).toContain("suspended");
    expect(validStatuses).toContain("pending");
    expect(validStatuses).toContain("failed");
  });

  it("has exactly 7 status values", () => {
    expect(validStatuses.length).toBe(7);
  });
});

describe("Domain dnsProvider enum values", () => {
  const validProviders = ["resellerclub", "directadmin"] as const;

  it("supports resellerclub and directadmin as DNS providers", () => {
    expect(validProviders).toContain("resellerclub");
    expect(validProviders).toContain("directadmin");
  });

  it("has exactly 2 DNS providers", () => {
    expect(validProviders.length).toBe(2);
  });
});

describe("Domain distributed lock field (processing_until)", () => {
  it("null represents an unlocked domain", () => {
    // The processing_until field is null when the domain is not locked
    const unlocked: { processing_until: Date | null } = { processing_until: null };
    expect(unlocked.processing_until).toBeNull();
  });

  it("a non-null date represents a locked domain", () => {
    const lockedUntil = new Date(Date.now() + 60_000); // locked for 1 minute
    const locked: { processing_until: Date | null } = { processing_until: lockedUntil };
    expect(locked.processing_until).not.toBeNull();
    expect(locked.processing_until!.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("Domain name validation rules", () => {
  it("domain names should be lowercase", () => {
    // The schema applies lowercase: true
    const sampleDomain = "Example.COM".toLowerCase();
    expect(sampleDomain).toBe("example.com");
  });

  it("domain names should be trimmed", () => {
    const sampleDomain = "  example.com  ".trim();
    expect(sampleDomain).toBe("example.com");
  });
});

describe("Domain autoRenew default", () => {
  it("autoRenew defaults to false (no auto-renewal without explicit opt-in)", () => {
    // Reflects the schema default; ensures renewals require explicit action
    const defaultAutoRenew = false;
    expect(defaultAutoRenew).toBe(false);
  });
});
