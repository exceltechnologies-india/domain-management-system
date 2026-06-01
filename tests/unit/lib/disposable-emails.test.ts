/**
 * Tests for `@/lib/disposable-emails` (rescan-4 slice 7dt).
 * Hand-curated disposable-email-domain blocklist. Pins:
 *  - isDisposableEmail returns true for known domains
 *  - Subdomain match via parent-domain walk (foo.mailinator.com hits
 *    'mailinator.com')
 *  - Case-insensitive matching
 *  - Malformed input (no @, undefined, non-string, missing TLD) → false
 *    (never throws — caller's email-format validation handles those)
 *  - Non-blocklisted domains pass through (gmail/yahoo)
 *  - getDisposableDomains returns the full list
 */
import { describe, it, expect } from "vitest";
import { isDisposableEmail, getDisposableDomains } from "@/lib/disposable-emails";

describe("isDisposableEmail", () => {
  it.each([
    "tempmail.com",
    "mailinator.com",
    "10minutemail.com",
    "guerrillamail.com",
    "yopmail.com",
    "trashmail.com",
  ])("flags known disposable domain %s", (domain) => {
    expect(isDisposableEmail(`user@${domain}`)).toBe(true);
  });

  it("matches subdomains via parent-domain walk", () => {
    expect(isDisposableEmail("user@foo.mailinator.com")).toBe(true);
    expect(isDisposableEmail("user@deep.nested.mailinator.com")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isDisposableEmail("USER@Mailinator.COM")).toBe(true);
    expect(isDisposableEmail("u@TEMPMAIL.com")).toBe(true);
  });

  it("returns false for legitimate domains (not on blocklist)", () => {
    expect(isDisposableEmail("user@gmail.com")).toBe(false);
    expect(isDisposableEmail("user@yahoo.com")).toBe(false);
    expect(isDisposableEmail("user@anutech.in")).toBe(false);
    expect(isDisposableEmail("user@example.test")).toBe(false);
  });

  it("returns false for malformed input (never throws)", () => {
    expect(isDisposableEmail("")).toBe(false);
    expect(isDisposableEmail("not-an-email")).toBe(false);
    expect(isDisposableEmail("user@")).toBe(false);
    expect(isDisposableEmail("@example.com")).toBe(false);
    expect(isDisposableEmail("user@no-tld")).toBe(false);
    // Non-string inputs (defensive).
    expect(isDisposableEmail(null as unknown as string)).toBe(false);
    expect(isDisposableEmail(undefined as unknown as string)).toBe(false);
    expect(isDisposableEmail(42 as unknown as string)).toBe(false);
  });

  it("guerrillamail family (multiple TLDs all blocked)", () => {
    expect(isDisposableEmail("u@guerrillamail.com")).toBe(true);
    expect(isDisposableEmail("u@guerrillamail.net")).toBe(true);
    expect(isDisposableEmail("u@guerrillamail.de")).toBe(true);
    expect(isDisposableEmail("u@guerrillamailblock.com")).toBe(true);
    expect(isDisposableEmail("u@sharklasers.com")).toBe(true);
  });
});

describe("getDisposableDomains", () => {
  it("returns the full blocklist as a readonly string[]", () => {
    const list = getDisposableDomains();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(30);
    expect(list).toContain("mailinator.com");
    expect(list).toContain("tempmail.com");
  });

  it("returned list is a fresh array (mutating it doesn't affect future calls)", () => {
    const list = getDisposableDomains() as string[];
    const originalLen = list.length;
    list.push("attacker-injected.com");
    expect(getDisposableDomains().length).toBe(originalLen);
  });
});
