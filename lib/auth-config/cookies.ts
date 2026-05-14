/**
 * NextAuth explicit cookie configuration.
 *
 * Hardens what NextAuth already does implicitly and makes the security
 * posture visible. __Secure-/__Host- prefixes require Secure + HTTPS.
 */

import { useSecureCookies } from "./helpers";

export const cookies = {
  sessionToken: {
    name: useSecureCookies
      ? "__Secure-next-auth.session-token"
      : "next-auth.session-token",
    options: {
      httpOnly: true,
      sameSite: "lax" as const,
      path: "/",
      secure: useSecureCookies,
    },
  },
  callbackUrl: {
    name: useSecureCookies
      ? "__Secure-next-auth.callback-url"
      : "next-auth.callback-url",
    options: {
      // httpOnly: false — the client must be able to read this for post-OAuth redirects
      httpOnly: false,
      sameSite: "lax" as const,
      path: "/",
      secure: useSecureCookies,
    },
  },
  csrfToken: {
    // __Host- prefix requires: Secure flag, no Domain attribute, path=/
    name: useSecureCookies
      ? "__Host-next-auth.csrf-token"
      : "next-auth.csrf-token",
    options: {
      httpOnly: true,
      sameSite: "lax" as const,
      path: "/",
      secure: useSecureCookies,
    },
  },
};
