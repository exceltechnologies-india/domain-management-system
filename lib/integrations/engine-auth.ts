/**
 * Auth for the Engine API — the surface this app exposes to ResellerOS.
 *
 * ─── WHAT THIS SURFACE IS, AND WHAT IT IS NOT ────────────────────────────────
 * This app KEEPS its customer portal and its admin panel. Nothing here retires
 * them. What changes is that ResellerOS gains a window onto the same data: it
 * shows a customer's domains and hosting inside pages it already has, and links
 * through to this app for the actual work (DNS records, nameservers, renewals).
 *
 * So this is federation, not migration. Read that literally when extending this
 * surface: an endpoint here exists to let ResellerOS DISPLAY what this app
 * knows, or to let it hand a user across. It is not a staging post for moving
 * ownership of domains and hosting out of this app.
 *
 * `app/api/integrations/billing/*` already exists for the narrower, earlier case
 * of ResellerOS provisioning a login account here. This module serves the
 * broader engine surface at `app/api/integrations/engine/*`. They are siblings,
 * not replacements, and they deliberately do NOT share a key — see below.
 *
 * ─── ONE KEY PER BLAST RADIUS ────────────────────────────────────────────────
 * `lib/integrations/billing-provision-auth.ts` established the rule this file
 * follows: a credential grants exactly one capability, so a leak costs exactly
 * that capability. The three inbound keys, weakest first:
 *
 *   ENGINE_READ_API_KEY        reads only. Cannot change anything, cannot spend.
 *   BILLING_PROVISION_API_KEY  creates a login account here.
 *   BILLING_COMMAND_API_KEY    triggers real infrastructure actions (register,
 *                              renew, suspend, delete) — the highest blast
 *                              radius in the integration.
 *
 * A read key is the one ResellerOS needs most often and holds in the most
 * places, which is exactly why it must not be able to register a domain.
 * Resist the temptation to let a stronger key satisfy a weaker check: that
 * turns three keys back into one and quietly restores the blast radius the
 * split exists to contain.
 *
 * ─── FAIL CLOSED ─────────────────────────────────────────────────────────────
 * An unset or empty env var returns false, so a misconfigured deployment
 * refuses every request rather than serving them unauthenticated. This is the
 * opposite of the usual "unset means default on" convention used by the feature
 * flags in this repo (`lib/reseller-flag.ts`, `lib/zoho-fallback-flag.ts`) —
 * deliberately, because those gate a behaviour and this gates a door.
 *
 * ─── CONSTANT TIME ───────────────────────────────────────────────────────────
 * Same reasoning as `lib/cron-auth.ts`: a `!==` compare leaks one character of
 * timing per request, which is enough to recover a secret over many probes. The
 * length check comes first because `timingSafeEqual` throws on buffers of
 * different lengths, and a malformed header should be a clean 401, not a 500.
 */
import crypto from "crypto";
import type { NextRequest } from "next/server";

/** The header both the Engine API and the older billing routes read. */
const INTEGRATION_KEY_HEADER = "x-integration-key";

/**
 * Constant-time compare of the presented header against an expected secret.
 * Never throws — every failure mode (missing env, missing header, length
 * mismatch, value mismatch, non-UTF8 bytes) resolves to false.
 */
function matchesSecret(request: NextRequest, expected: string | undefined): boolean {
  if (!expected || expected.length === 0) return false;

  const provided = request.headers.get(INTEGRATION_KEY_HEADER) ?? "";
  if (provided.length !== expected.length) return false;

  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Authorise a READ against the Engine API. Grants no ability to change
 * anything: callers of this must not mutate state or contact a paid upstream.
 */
export function authorizeEngineReadRequest(request: NextRequest): boolean {
  return matchesSecret(request, process.env.ENGINE_READ_API_KEY);
}

/**
 * Authorise a COMMAND against the Engine API — an action with real-world,
 * often irreversible effect (registering a domain, creating a hosting account).
 *
 * Shares `BILLING_COMMAND_API_KEY` with the existing billing command routes
 * rather than minting a fourth secret: the capability being granted is
 * identical ("trigger real infrastructure actions"), and a second key for the
 * same capability is a second thing to rotate, not a second boundary.
 *
 * No command route exists yet. This is exported so that when the first one
 * lands it cannot reach for the read key by accident.
 */
export function authorizeEngineCommandRequest(request: NextRequest): boolean {
  return matchesSecret(request, process.env.BILLING_COMMAND_API_KEY);
}
