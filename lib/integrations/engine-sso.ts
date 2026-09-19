/**
 * Inbound SSO — accepting a signed hand-off from ResellerOS so someone who is
 * already signed in there lands here signed in too, instead of at a login form.
 *
 * ─── THE TOKEN SAYS WHO, NEVER WHAT ──────────────────────────────────────────
 * The single most important rule in this file. The hand-off carries an EMAIL
 * and nothing about permissions. This app looks that email up in its OWN user
 * collection and takes the role from there.
 *
 * The alternative — letting the token assert `role: "admin"` — would mean
 * anyone who obtained the shared secret could mint themselves an admin session
 * here, and it would silently couple two permission models that are going to
 * drift. A ResellerOS "owner" is not a DMS admin, and should not become one by
 * crossing a network boundary.
 *
 * ─── IT NEVER CREATES AN ACCOUNT ─────────────────────────────────────────────
 * An email with no user here is a refusal, not a signup. Auto-provisioning on
 * SSO turns the shared secret into an account-creation primitive: anyone able
 * to mint a token could conjure a login for any address. Account creation has
 * its own route, its own key, and its own audit trail
 * (app/api/integrations/billing/provision-customer).
 *
 * ─── SINGLE USE, AND SHORT ───────────────────────────────────────────────────
 * The token rides in a URL, so it will end up in browser history, in a proxy
 * log, and in whatever the user pastes into a support chat. Two defences:
 * a 60-second expiry, and a `jti` consumed exactly once in Redis. A replayed
 * token is refused even inside its own lifetime.
 *
 * If Redis is unavailable the hand-off is REFUSED rather than allowed through
 * unguarded. That is deliberate: a login that silently loses its replay
 * protection when a cache is down is worse than a login that stops working
 * visibly.
 *
 * ─── ITS OWN SECRET ──────────────────────────────────────────────────────────
 * `ENGINE_SSO_SECRET`, separate from NEXTAUTH_SECRET and JWT_SECRET — the same
 * reasoning lib/integrations/support-sso.ts uses in the other direction. A leak
 * of one must not compromise the others, and this one is shared with a second
 * application, which makes it the likeliest of the three to leak.
 */
import jwt from "jsonwebtoken";
import { serverLogger } from "@/lib/server-logger";

/**
 * Redis is imported lazily, inside the function, on purpose.
 *
 * `lib/redis.ts` does real work at MODULE LOAD: it constructs an ioredis client
 * and warns when REDIS_HOST is unset. This module is imported by
 * `lib/auth-config/providers.ts`, which means a static import would run both of
 * those every time the NextAuth route loads — a side effect in the
 * authentication path that has nothing to do with authentication, and which is
 * paid even by requests that never touch SSO.
 *
 * Deferring it keeps the auth import graph clean. The cost is one dynamic
 * import on a code path that is already doing network I/O.
 */
async function getRedis() {
  const mod = await import("@/lib/redis");
  return mod.redis;
}

/** Matches the `purpose` the minting side stamps; a token for anything else is refused. */
const SSO_PURPOSE = "engine-sso";

/** Long enough to survive a redirect, too short to be worth stealing from a log. */
const MAX_AGE_SECONDS = 60;

/** Replay keys outlive the token slightly, so a token cannot be replayed at its own expiry edge. */
const JTI_TTL_SECONDS = MAX_AGE_SECONDS * 2;

export interface EngineSsoClaims {
  /** The person's email address in ResellerOS. The join key, and the only identity carried. */
  email: string;
  /** Opaque id of the ResellerOS user, for log correlation only — never trusted for authorisation. */
  sourceUserId?: string;
  jti: string;
}

export type SsoFailure =
  | "not_configured"
  | "invalid_token"
  | "expired"
  | "wrong_purpose"
  | "replayed"
  | "replay_store_unavailable";

export type SsoResult =
  | { ok: true; claims: EngineSsoClaims }
  | { ok: false; reason: SsoFailure };

/**
 * Verify a hand-off token and consume its `jti` so it cannot be used twice.
 *
 * Consumption happens only AFTER the signature and expiry check pass, so a
 * garbage token cannot be used to fill Redis with junk keys.
 */
export async function verifyAndConsumeSsoToken(token: string): Promise<SsoResult> {
  const secret = process.env.ENGINE_SSO_SECRET;
  if (!secret || secret.length === 0) {
    // Unset means the feature is off. Fail closed, like every other door in
    // this integration (see lib/integrations/engine-auth.ts).
    return { ok: false, reason: "not_configured" };
  }

  let payload: jwt.JwtPayload;
  try {
    const decoded = jwt.verify(token, secret, {
      algorithms: ["HS256"], // pinned: without this, `alg: none` is negotiable
      maxAge: MAX_AGE_SECONDS,
    });
    if (typeof decoded === "string") return { ok: false, reason: "invalid_token" };
    payload = decoded;
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    return { ok: false, reason: name === "TokenExpiredError" ? "expired" : "invalid_token" };
  }

  if (payload.purpose !== SSO_PURPOSE) {
    // Stops a token minted for some other future purpose, with the same secret,
    // being spent here.
    return { ok: false, reason: "wrong_purpose" };
  }

  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  const jti = typeof payload.jti === "string" ? payload.jti : "";
  if (!email || !jti) return { ok: false, reason: "invalid_token" };

  const redis = await getRedis();
  if (!redis) {
    serverLogger.error(
      "[engine-sso] Refused a valid token: no Redis, so single-use cannot be enforced."
    );
    return { ok: false, reason: "replay_store_unavailable" };
  }

  try {
    // NX makes this the atomic claim: the first caller sets the key, everyone
    // after gets null. A get-then-set would let two simultaneous replays both
    // observe "unused" and both succeed.
    const claimed = await redis.set(`engine-sso:jti:${jti}`, "1", "EX", JTI_TTL_SECONDS, "NX");
    if (claimed !== "OK") {
      serverLogger.warn(`[engine-sso] Replay refused for ${email} (jti ${jti})`);
      return { ok: false, reason: "replayed" };
    }
  } catch (err) {
    serverLogger.error("[engine-sso] Replay store failed; refusing hand-off.", err);
    return { ok: false, reason: "replay_store_unavailable" };
  }

  return {
    ok: true,
    claims: {
      email,
      sourceUserId: typeof payload.sub === "string" ? payload.sub : undefined,
      jti,
    },
  };
}
