/**
 * Tests for the primary-billing kill-switch `@/lib/primary-billing-flag`.
 * DEFAULT OFF (inverse of RESELLER_FEATURE_ENABLED) — enabled ONLY on an
 * explicit truthy value. Unset/empty/garbage all mean disabled, unlike the
 * reseller flag where unset means enabled.
 */
import { describe, it, expect, afterEach } from "vitest";
import { isPrimaryBillingEnabled } from "@/lib/primary-billing-flag";

const ORIG = process.env.PRIMARY_BILLING_ENABLED;
afterEach(() => {
  if (ORIG === undefined) delete process.env.PRIMARY_BILLING_ENABLED;
  else process.env.PRIMARY_BILLING_ENABLED = ORIG;
});

describe("isPrimaryBillingEnabled", () => {
  it("unset → disabled (default OFF)", () => {
    delete process.env.PRIMARY_BILLING_ENABLED;
    expect(isPrimaryBillingEnabled()).toBe(false);
  });

  it("empty string → disabled", () => {
    process.env.PRIMARY_BILLING_ENABLED = "";
    expect(isPrimaryBillingEnabled()).toBe(false);
  });

  it.each(["false", "0", "no", "off", "garbage", " "])(
    "non-truthy %o → disabled",
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
});
