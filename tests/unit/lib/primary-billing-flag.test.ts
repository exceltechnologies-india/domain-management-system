/**
 * Tests for the primary-billing kill-switch `@/lib/primary-billing-flag`.
 *
 * **DEFAULT ON** as of 2026-09-03 (operator decision): our own GST engine is
 * the primary invoice issuer and Zoho Books is the automatic fallback. Same
 * shape as RESELLER_FEATURE_ENABLED — enabled unless EXPLICITLY set to a
 * falsey value.
 *
 * This inverted on 2026-09-03. It previously defaulted OFF (opt-in) while the
 * engine was under review; the post-Phase-2 audit closed the last correctness
 * gaps, so it now ships enabled. The tests below pin BOTH halves — the new
 * default and the disable path — because the disable path is the emergency
 * rollback for live payments and must keep working.
 */
import { describe, it, expect, afterEach } from "vitest";
import { isPrimaryBillingEnabled } from "@/lib/primary-billing-flag";

const ORIG = process.env.PRIMARY_BILLING_ENABLED;
afterEach(() => {
  if (ORIG === undefined) delete process.env.PRIMARY_BILLING_ENABLED;
  else process.env.PRIMARY_BILLING_ENABLED = ORIG;
});

describe("isPrimaryBillingEnabled", () => {
  it("**unset → ENABLED (default ON)**", () => {
    delete process.env.PRIMARY_BILLING_ENABLED;
    expect(isPrimaryBillingEnabled()).toBe(true);
  });

  it("empty string → enabled (an env var present-but-blank is the same as unset)", () => {
    process.env.PRIMARY_BILLING_ENABLED = "";
    expect(isPrimaryBillingEnabled()).toBe(true);
  });

  it.each(["false", "0", "no", "off", "FALSE", " Off "])(
    "**explicit falsey %o → DISABLED** (the emergency rollback path for live payments)",
    (v) => {
      process.env.PRIMARY_BILLING_ENABLED = v;
      expect(isPrimaryBillingEnabled()).toBe(false);
    }
  );

  it.each(["true", "1", "yes", "on", "TRUE", " On "])(
    "explicit truthy %o → enabled",
    (v) => {
      process.env.PRIMARY_BILLING_ENABLED = v;
      expect(isPrimaryBillingEnabled()).toBe(true);
    }
  );

  it.each(["garbage", "flase", "disabled", "1.0"])(
    "unrecognised value %o → ENABLED (fail-open, matching reseller-flag)",
    (v) => {
      // Deliberate, and the safe direction here: the primary engine has an
      // automatic Zoho fallback, so "enabled" can never mean "no invoice
      // issued". A typo'd disable (e.g. "flase") therefore degrades to the
      // intended default rather than silently reverting customers to
      // Zoho-numbered invoices when the operator believes the GST engine is
      // live — which is the genuinely surprising outcome.
      process.env.PRIMARY_BILLING_ENABLED = v;
      expect(isPrimaryBillingEnabled()).toBe(true);
    }
  );

  it("whitespace-only → enabled (trimmed to empty, i.e. unset)", () => {
    process.env.PRIMARY_BILLING_ENABLED = "   ";
    expect(isPrimaryBillingEnabled()).toBe(true);
  });
});
