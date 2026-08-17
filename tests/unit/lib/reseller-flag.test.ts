/**
 * Tests for the sub-reseller kill-switch `@/lib/reseller-flag`.
 * DEFAULT ON: enabled unless RESELLER_FEATURE_ENABLED is explicitly falsey.
 */
import { describe, it, expect, afterEach } from "vitest";
import { isResellerFeatureEnabled } from "@/lib/reseller-flag";

const ORIG = process.env.RESELLER_FEATURE_ENABLED;
afterEach(() => {
  if (ORIG === undefined) delete process.env.RESELLER_FEATURE_ENABLED;
  else process.env.RESELLER_FEATURE_ENABLED = ORIG;
});

describe("isResellerFeatureEnabled", () => {
  it("unset → enabled (default ON)", () => {
    delete process.env.RESELLER_FEATURE_ENABLED;
    expect(isResellerFeatureEnabled()).toBe(true);
  });

  it("empty string → enabled", () => {
    process.env.RESELLER_FEATURE_ENABLED = "";
    expect(isResellerFeatureEnabled()).toBe(true);
  });

  it.each(["false", "0", "no", "off", "OFF", " False "])(
    "explicit falsey %o → disabled",
    (v) => {
      process.env.RESELLER_FEATURE_ENABLED = v;
      expect(isResellerFeatureEnabled()).toBe(false);
    }
  );

  it.each(["true", "1", "yes", "on", "anything"])(
    "truthy/other %o → enabled",
    (v) => {
      process.env.RESELLER_FEATURE_ENABLED = v;
      expect(isResellerFeatureEnabled()).toBe(true);
    }
  );
});
