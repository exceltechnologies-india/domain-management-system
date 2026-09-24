/**
 * The tokens recurring-charge flow is OFF, and must stay off by default.
 *
 * Recurring billing moved to ResellerOS on 24 Sep 2026, which collects through
 * Razorpay Subscriptions (UPI Autopay / e-NACH). DMS's flow is the Tokens API,
 * where WE fire each debit — so leaving it running alongside would mean two
 * independent systems able to collect the same renewal.
 *
 * WHY THAT IS THE DANGEROUS PART, not the cost: this service dedups on
 * (hostingId, dueDate) inside DMS's own Mongo. It has no knowledge of
 * ResellerOS, and ResellerOS has none of it. A double debit would be caught by
 * nothing on either side — the customer would be the detector.
 *
 * These assert the SHAPE that keeps it off:
 *   - unset means off (nobody has to remember to disable it),
 *   - only an exact "1" turns it on,
 *   - the gate sits at the chokepoint, so the script caller cannot walk
 *     around it (L65),
 *   - and no card is touched before the gate — the refusal happens before any
 *     Razorpay call, not after one that half-succeeded.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVICE = join(process.cwd(), "lib/services/payment/recurring-charge-service.ts");
const ORIGINAL = process.env.DMS_TOKEN_RECURRING_ENABLED;

/** Mirrors the production predicate exactly; see the assertion below that pins it. */
const enabled = () => process.env.DMS_TOKEN_RECURRING_ENABLED === "1";

function set(v: string | undefined) {
  if (v === undefined) delete process.env.DMS_TOKEN_RECURRING_ENABLED;
  else process.env.DMS_TOKEN_RECURRING_ENABLED = v;
}

beforeEach(() => set(undefined));
afterEach(() => set(ORIGINAL));

describe("the switch fails closed", () => {
  it("is OFF when the variable is unset", () => {
    expect(enabled()).toBe(false);
  });

  it("stays off for empty, misspelled and truthy-looking values", () => {
    for (const v of ["", "0", "true", "yes", "on", " 1", "01"]) {
      set(v);
      expect(enabled(), `value ${JSON.stringify(v)}`).toBe(false);
    }
  });

  it("turns on only for an exact 1", () => {
    set("1");
    expect(enabled()).toBe(true);
  });
});

describe("the gate is where it cannot be bypassed", () => {
  const src = readFileSync(SERVICE, "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");

  it("lives inside chargeRecurringHosting, not in the cron route", () => {
    /**
     * `scripts/charge-recurring-hostings.js` calls this function directly. A
     * gate in app/api/workers/tokens-charge-recurring would leave that script
     * able to charge cards (L65).
     */
    const fnAt = code.indexOf("export async function chargeRecurringHosting");
    const gateAt = code.indexOf("DMS_TOKEN_RECURRING_ENABLED");
    expect(fnAt, "chargeRecurringHosting not found").toBeGreaterThan(-1);
    expect(gateAt, "gate not found in the service").toBeGreaterThan(fnAt);
  });

  it("uses an exact === \"1\" comparison, not a truthy check", () => {
    expect(code).toMatch(/DMS_TOKEN_RECURRING_ENABLED\s*!==\s*"1"/);
  });

  it("refuses BEFORE any Razorpay call in that function", () => {
    /**
     * Ordering is the assertion. A gate placed after the charge would skip the
     * bookkeeping while the money had already moved — the worst shape
     * available on a money path.
     */
    const gateAt = code.indexOf("DMS_TOKEN_RECURRING_ENABLED");
    const chargeAt = code.indexOf("chargeViaToken");
    expect(chargeAt, "chargeViaToken not found — has the service changed?").toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(chargeAt);
  });

  it("is a skip, not a throw — a disabled feature is not a failed run", () => {
    /**
     * The nightly cron must report a clean night, not an error. An error
     * bucket full of "disabled" is how a real failure gets skimmed past (L6).
     */
    const around = code.slice(code.indexOf("DMS_TOKEN_RECURRING_ENABLED"), code.indexOf("DMS_TOKEN_RECURRING_ENABLED") + 400);
    expect(around).toContain('outcome: "skipped"');
    expect(around).not.toContain("throw");
  });
});

describe("the code is gated, not deleted", () => {
  const src = readFileSync(SERVICE, "utf8");

  it("keeps the machinery that would be expensive to rebuild", () => {
    /**
     * Pardeep: disabled "until we need it someday later". The dedup claim, the
     * abandon-on-first-failure rule and the yearly/monthly inference are all
     * hard-won and stay. If this test fails because they were removed, that was
     * a decision nobody recorded.
     */
    expect(src).toContain("chargeViaToken");
    expect(src).toContain("RecurringChargeAttempt");
  });
});
