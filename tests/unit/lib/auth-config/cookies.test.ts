/**
 * Tests for `@/lib/auth-config/cookies` (rescan-4 slice 7de).
 * Explicit NextAuth cookie config — pins the cookie names, the security
 * flag set, and the __Secure-/__Host- prefix gating on `useSecureCookies`.
 *
 * `useSecureCookies` is a compile-time constant derived from
 * `process.env.NEXTAUTH_URL`. In the test runtime NEXTAUTH_URL is
 * generally unset (or http://...), so useSecureCookies=false. We assert
 * the unprefixed names; the prefixed variants are structurally pinned
 * via the conditional logic in the source.
 */
import { describe, it, expect } from "vitest";
import { cookies } from "@/lib/auth-config/cookies";
import { useSecureCookies } from "@/lib/auth-config/helpers";

describe("auth-config cookies", () => {
  it("declares the 3 NextAuth cookie groups", () => {
    expect(cookies).toHaveProperty("sessionToken");
    expect(cookies).toHaveProperty("callbackUrl");
    expect(cookies).toHaveProperty("csrfToken");
  });

  it("sessionToken cookie: httpOnly + sameSite='lax' + path='/'", () => {
    const opts = cookies.sessionToken.options;
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe("lax");
    expect(opts.path).toBe("/");
    expect(opts.secure).toBe(useSecureCookies);
  });

  it("callbackUrl cookie: NOT httpOnly (client reads it for post-OAuth redirects)", () => {
    expect(cookies.callbackUrl.options.httpOnly).toBe(false);
    expect(cookies.callbackUrl.options.sameSite).toBe("lax");
  });

  it("csrfToken cookie: httpOnly + lax sameSite", () => {
    expect(cookies.csrfToken.options.httpOnly).toBe(true);
    expect(cookies.csrfToken.options.sameSite).toBe("lax");
  });

  it("cookie names use __Secure-/__Host- prefixes when useSecureCookies=true; unprefixed otherwise", () => {
    if (useSecureCookies) {
      expect(cookies.sessionToken.name).toBe("__Secure-next-auth.session-token");
      expect(cookies.callbackUrl.name).toBe("__Secure-next-auth.callback-url");
      expect(cookies.csrfToken.name).toBe("__Host-next-auth.csrf-token");
    } else {
      expect(cookies.sessionToken.name).toBe("next-auth.session-token");
      expect(cookies.callbackUrl.name).toBe("next-auth.callback-url");
      expect(cookies.csrfToken.name).toBe("next-auth.csrf-token");
    }
  });

  it("csrfToken uses __Host- prefix (not __Secure-) when secure — path=/ + no Domain is required for __Host-", () => {
    if (useSecureCookies) {
      expect(cookies.csrfToken.name.startsWith("__Host-")).toBe(true);
    }
    // path=/ is mandatory for the __Host- prefix even when not using it.
    expect(cookies.csrfToken.options.path).toBe("/");
  });
});
