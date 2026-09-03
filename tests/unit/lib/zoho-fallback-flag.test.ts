/**
 * Tests for the Zoho-invoice fallback kill-switch `@/lib/zoho-fallback-flag`.
 *
 * Replaces `primary-billing-flag.test.ts`, deleted 2026-09-03 when the switch
 * moved. The primary GST engine is now **permanent and ungated** — there is
 * deliberately no flag that can stop it issuing our own TI/... tax invoices.
 * What remains optional is whether Zoho Books acts as the safety net when the
 * primary engine fails.
 *
 * DEFAULT ON, opt-out shape (same as RESELLER_FEATURE_ENABLED): the fallback
 * is enabled unless EXPLICITLY set to a falsey value.
 */
import { describe, it, expect, afterEach } from "vitest";
import { isZohoInvoiceFallbackEnabled } from "@/lib/zoho-fallback-flag";

const ORIG = process.env.ZOHO_INVOICE_FALLBACK_ENABLED;
afterEach(() => {
  if (ORIG === undefined) delete process.env.ZOHO_INVOICE_FALLBACK_ENABLED;
  else process.env.ZOHO_INVOICE_FALLBACK_ENABLED = ORIG;
});

describe("isZohoInvoiceFallbackEnabled", () => {
  it("**unset → ENABLED (default ON)** — a payment is never left uninvoiced by an engine bug", () => {
    delete process.env.ZOHO_INVOICE_FALLBACK_ENABLED;
    expect(isZohoInvoiceFallbackEnabled()).toBe(true);
  });

  it("empty string → enabled (present-but-blank is the same as unset)", () => {
    process.env.ZOHO_INVOICE_FALLBACK_ENABLED = "";
    expect(isZohoInvoiceFallbackEnabled()).toBe(true);
  });

  it("whitespace-only → enabled (trimmed to empty)", () => {
    process.env.ZOHO_INVOICE_FALLBACK_ENABLED = "   ";
    expect(isZohoInvoiceFallbackEnabled()).toBe(true);
  });

  it.each(["false", "0", "no", "off", "FALSE", " Off "])(
    "**explicit falsey %o → DISABLED** — a primary-engine failure then surfaces instead of being papered over by a Zoho-numbered invoice",
    (v) => {
      process.env.ZOHO_INVOICE_FALLBACK_ENABLED = v;
      expect(isZohoInvoiceFallbackEnabled()).toBe(false);
    }
  );

  it.each(["true", "1", "yes", "on", "TRUE", " On "])(
    "explicit truthy %o → enabled",
    (v) => {
      process.env.ZOHO_INVOICE_FALLBACK_ENABLED = v;
      expect(isZohoInvoiceFallbackEnabled()).toBe(true);
    }
  );

  it.each(["garbage", "flase", "disabled"])(
    "unrecognised value %o → ENABLED (fail-open)",
    (v) => {
      // Failing open keeps the safety net in place. A typo'd disable
      // therefore degrades to "a customer still gets an invoice", not to
      // "a paid customer silently gets none".
      process.env.ZOHO_INVOICE_FALLBACK_ENABLED = v;
      expect(isZohoInvoiceFallbackEnabled()).toBe(true);
    }
  );
});
