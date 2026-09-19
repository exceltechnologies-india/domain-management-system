/**
 * /sso — where a hand-off from ResellerOS lands.
 *
 * ─── WHY A PAGE AND NOT A ROUTE HANDLER ──────────────────────────────────────
 * The obvious design is an API route that verifies the token and writes a
 * session cookie. That means hand-encoding a NextAuth JWT, which skips every
 * check the `jwt` callback performs — the account-disabled check, the
 * `sessionInvalidatedAt` check, the session timeout. A disabled user would have
 * walked straight in.
 *
 * So instead this page hands the token to NextAuth's own `signIn()` against the
 * `engine-sso` provider. NextAuth mints the session, every callback runs, and
 * this file stays a spinner with no security logic in it at all. The verifying
 * happens in lib/integrations/engine-sso.ts and the provider's `authorize`.
 *
 * `signIn` also handles the CSRF token and restricts `callbackUrl` to this
 * origin, so the `next` parameter cannot be turned into an open redirect.
 */
"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";

function SsoHandoff() {
  const params = useSearchParams();
  const [failed, setFailed] = useState(false);
  // React 18 StrictMode mounts effects twice in development. The token is
  // single-use, so a second call would consume it and report a replay — this
  // guard keeps the hand-off working in dev.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const token = params.get("token");
    if (!token) {
      setFailed(true);
      return;
    }

    // `next` is where the person was trying to go. NextAuth rejects an
    // off-origin callbackUrl, so a crafted value falls back to the default
    // rather than redirecting somewhere else.
    const next = params.get("next") || "/admin";

    void signIn("engine-sso", { token, callbackUrl: next });
  }, [params]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-8 text-center shadow-sm">
        {failed ? (
          <>
            <h1 className="text-lg font-semibold text-gray-900">
              This sign-in link is not valid
            </h1>
            <p className="mt-2 text-sm text-gray-600">
              Hand-off links last about a minute and work only once. Go back to
              ResellerOS and click through again.
            </p>
            <a
              href="/login"
              className="mt-5 inline-block text-sm font-medium text-blue-600 underline underline-offset-4"
            >
              Or sign in here instead
            </a>
          </>
        ) : (
          <>
            <div
              className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-gray-200 border-t-blue-600"
              role="status"
              aria-label="Signing you in"
            />
            <h1 className="mt-4 text-lg font-semibold text-gray-900">
              Signing you in…
            </h1>
            <p className="mt-1 text-sm text-gray-600">Bringing you over from ResellerOS.</p>
          </>
        )}
      </div>
    </div>
  );
}

export default function SsoPage() {
  // useSearchParams needs a Suspense boundary, or the whole route opts out of
  // static rendering and Next warns at build time.
  return (
    <Suspense fallback={null}>
      <SsoHandoff />
    </Suspense>
  );
}
