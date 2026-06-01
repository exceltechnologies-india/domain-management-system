/**
 * Tests for `@/lib/razorpay-client` (rescan-4 slice 7ed).
 * The one Razorpay SDK instance + L1 typed-facade. Pins:
 *  - throws at module-load when RAZORPAY_KEY_ID / KEY_SECRET missing
 *    (configuration-error fail-fast — preferable to a 401 on first
 *    payment attempt because it surfaces at boot, not under traffic)
 *  - SDK constructor called with key_id + key_secret from env
 *  - **api.defaults.timeout is set to 30_000** (the L1 fix: a hung
 *    Razorpay slot would otherwise stall payment-verify indefinitely
 *    — mirrors the resolved [H3] Zoho axios timeout)
 *  - both `razorpayClient` and `razorpay` are exported and reference
 *    the same singleton SDK instance (the L1 collapse: prior to this
 *    module, 10 callsites each constructed their own SDK)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sdkInstance = vi.hoisted(() => ({
  api: { defaults: { timeout: undefined as number | undefined } },
  orders: {},
  payments: {},
  subscriptions: {},
  plans: {},
}));
// A real `function` is needed (not an arrow) so the SDK consumer can
// call it with `new`. Arrow fns lack the [[Construct]] slot. A
// function that returns an object explicitly overrides `this`, so
// `new RazorpayCtor(...)` evaluates to sdkInstance directly.
const RazorpayCtor = vi.hoisted(
  () =>
    vi.fn(function () {
      return sdkInstance;
    }) as unknown as new (opts: unknown) => typeof sdkInstance
);
vi.mock("razorpay", () => ({ default: RazorpayCtor }));

const ORIG_ID = process.env.RAZORPAY_KEY_ID;
const ORIG_SECRET = process.env.RAZORPAY_KEY_SECRET;

beforeEach(() => {
  (RazorpayCtor as unknown as { mockClear: () => void }).mockClear();
  sdkInstance.api.defaults.timeout = undefined;
  vi.resetModules();
});

afterEach(() => {
  process.env.RAZORPAY_KEY_ID = ORIG_ID;
  process.env.RAZORPAY_KEY_SECRET = ORIG_SECRET;
});

describe("module-load env validation", () => {
  it("throws when RAZORPAY_KEY_ID is missing", async () => {
    delete process.env.RAZORPAY_KEY_ID;
    process.env.RAZORPAY_KEY_SECRET = "secret";
    await expect(import("@/lib/razorpay-client")).rejects.toThrow(
      /Razorpay configuration is missing/
    );
  });

  it("throws when RAZORPAY_KEY_SECRET is missing", async () => {
    process.env.RAZORPAY_KEY_ID = "id";
    delete process.env.RAZORPAY_KEY_SECRET;
    await expect(import("@/lib/razorpay-client")).rejects.toThrow(
      /Razorpay configuration is missing/
    );
  });

  it("throws when both are missing", async () => {
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    await expect(import("@/lib/razorpay-client")).rejects.toThrow(
      /Razorpay configuration is missing/
    );
  });
});

describe("SDK construction", () => {
  it("Razorpay ctor called with key_id + key_secret from env", async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_KID";
    process.env.RAZORPAY_KEY_SECRET = "rzp_test_KSECRET";
    await import("@/lib/razorpay-client");
    expect(RazorpayCtor).toHaveBeenCalledTimes(1);
    expect(RazorpayCtor).toHaveBeenCalledWith({
      key_id: "rzp_test_KID",
      key_secret: "rzp_test_KSECRET",
    });
  });

  it("api.defaults.timeout set to 30_000 (the L1 fix vs hung Razorpay slots)", async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_KID";
    process.env.RAZORPAY_KEY_SECRET = "rzp_test_KSECRET";
    await import("@/lib/razorpay-client");
    expect(sdkInstance.api.defaults.timeout).toBe(30_000);
  });

  it("razorpayClient and razorpay both point at the SAME singleton SDK instance (L1 collapse)", async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_KID";
    process.env.RAZORPAY_KEY_SECRET = "rzp_test_KSECRET";
    const mod = await import("@/lib/razorpay-client");
    expect(mod.razorpay).toBe(mod.razorpayClient);
    expect(mod.razorpay).toBe(sdkInstance);
  });
});
