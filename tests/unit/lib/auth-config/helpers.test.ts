/**
 * Tests for `@/lib/auth-config/helpers` (rescan-4 slice 7dj).
 * Pins:
 *  - extractSocialName per-provider name parsing (google/github/facebook)
 *  - Fallback when profile fields are missing — uses user.name split
 *  - SOCIAL_PROVIDERS constant shape
 *  - useSecureCookies is true when NEXTAUTH_URL starts with https://,
 *    false otherwise
 *
 * useSecureCookies is read at module-load time (it's a const, not a fn),
 * so we use dynamic imports + vi.resetModules to test both branches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  extractSocialName,
  SOCIAL_PROVIDERS,
  type GoogleProfile,
  type GithubProfile,
} from "@/lib/auth-config/helpers";

describe("SOCIAL_PROVIDERS", () => {
  it("is a 3-entry list of supported provider IDs", () => {
    expect(SOCIAL_PROVIDERS).toEqual(["google", "facebook", "github"]);
  });
});

describe("extractSocialName", () => {
  it("google: uses given_name + family_name from the profile", () => {
    const profile: GoogleProfile = { given_name: "Ada", family_name: "Lovelace" };
    const result = extractSocialName("google", profile, { name: "Ada Lovelace" });
    expect(result).toEqual({ firstName: "Ada", lastName: "Lovelace" });
  });

  it("google: falls back to user.name split when given_name/family_name absent", () => {
    const result = extractSocialName("google", {}, { name: "Ada Augusta Lovelace" });
    expect(result).toEqual({ firstName: "Ada", lastName: "Augusta Lovelace" });
  });

  it("github: prefers profile.name, then login, then user.name", () => {
    const fromName = extractSocialName(
      "github",
      { name: "Ada Lovelace" } as GithubProfile,
      { name: "ignored" }
    );
    expect(fromName).toEqual({ firstName: "Ada", lastName: "Lovelace" });

    const fromLogin = extractSocialName(
      "github",
      { login: "ada-lovelace" } as GithubProfile,
      { name: null }
    );
    // The login string has no space → entire login is firstName.
    expect(fromLogin).toEqual({ firstName: "ada-lovelace", lastName: "" });

    const fromUserName = extractSocialName(
      "github",
      {} as GithubProfile,
      { name: "Ada Lovelace" }
    );
    expect(fromUserName).toEqual({ firstName: "Ada", lastName: "Lovelace" });
  });

  it("github: empty display name → {firstName:'', lastName:''}", () => {
    const result = extractSocialName("github", {}, { name: "" });
    expect(result).toEqual({ firstName: "", lastName: "" });
  });

  it("facebook (and unknown providers): splits user.name only", () => {
    expect(extractSocialName("facebook", {}, { name: "Ada Lovelace" })).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
    });
    // Unknown provider falls through the same branch.
    expect(extractSocialName("weird", {}, { name: "Just One" })).toEqual({
      firstName: "Just",
      lastName: "One",
    });
  });

  it("missing user.name + missing profile fields → empty strings (never throws)", () => {
    const result = extractSocialName("facebook", undefined, {});
    expect(result).toEqual({ firstName: "", lastName: "" });
  });
});

describe("useSecureCookies", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("true when NEXTAUTH_URL starts with https://", async () => {
    vi.stubEnv("NEXTAUTH_URL", "https://dms.example.com");
    const { useSecureCookies } = await import("@/lib/auth-config/helpers");
    expect(useSecureCookies).toBe(true);
  });

  it("false when NEXTAUTH_URL starts with http:// (local dev)", async () => {
    vi.stubEnv("NEXTAUTH_URL", "http://localhost:3000");
    const { useSecureCookies } = await import("@/lib/auth-config/helpers");
    expect(useSecureCookies).toBe(false);
  });

  it("false when NEXTAUTH_URL is unset (defensive nullish chain)", async () => {
    vi.stubEnv("NEXTAUTH_URL", "");
    const { useSecureCookies } = await import("@/lib/auth-config/helpers");
    expect(useSecureCookies).toBe(false);
  });
});
