/**
 * Auth for the inbound Billing Panel -> Customer Panel provisioning route.
 * Deliberately a separate secret from BILLING_INTEGRATION_API_KEY (which
 * Customer Panel uses to call OUT to Billing, read-only) — this is Billing
 * calling IN, to create a real login account, so it gets its own key.
 * Timing-safe compare, same approach as lib/cron-auth.ts.
 */
import crypto from "crypto";
import type { NextRequest } from "next/server";

export function authorizeBillingProvisionRequest(request: NextRequest): boolean {
  const expected = process.env.BILLING_PROVISION_API_KEY;
  if (!expected || expected.length === 0) return false;

  const provided = request.headers.get("x-integration-key") ?? "";
  if (provided.length !== expected.length) return false;

  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Auth for Billing calling IN to trigger domain/hosting execution commands
 * (renew, suspend, delete). A THIRD, separate secret from both
 * BILLING_PROVISION_API_KEY (account creation) and CRON_SECRET (Cloud
 * Scheduler) — this one specifically grants "trigger real infrastructure
 * actions," the highest-blast-radius capability in this integration, so it
 * gets its own key rather than piggybacking on either existing one.
 */
export function authorizeBillingCommandRequest(request: NextRequest): boolean {
  const expected = process.env.BILLING_COMMAND_API_KEY;
  if (!expected || expected.length === 0) return false;

  const provided = request.headers.get("x-integration-key") ?? "";
  if (provided.length !== expected.length) return false;

  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}
