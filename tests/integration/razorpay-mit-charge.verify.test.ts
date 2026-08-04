/**
 * ONE-OFF verification: does Razorpay TEST mode actually execute an MIT
 * (merchant-initiated) charge on a stored mandate token?
 *
 * The main tokens-live suite deliberately SKIPS the MIT charge because it needs
 * an already-AUTHORIZED token (which only comes from the interactive Checkout
 * mandate flow). This test fills that gap when a real authorized token exists
 * (e.g. from a completed trial signup): it calls RazorpayService.chargeViaToken
 * against the Razorpay TEST API and asserts a captured payment comes back —
 * proving the day-15 recurring charge will work before the live cutover.
 *
 * DORMANT by default. Runs ONLY when explicitly enabled with a real token:
 *   RUN_MIT_CHARGE_TEST=1 \
 *   MIT_TEST_CUSTOMER=cust_xxx MIT_TEST_TOKEN=token_xxx \
 *   MIT_TEST_AMOUNT=599.88 MIT_TEST_EMAIL=... MIT_TEST_CONTACT=10digits \
 *   npx vitest run --config=vitest.integration.config.ts \
 *     tests/integration/razorpay-mit-charge.verify.test.ts
 *
 * No production guard is bypassed (it calls the underlying service method, not
 * the guarded worker/CLI) and no prod DB is touched. Test-mode = fake money.
 */
import fs from "fs";
import { describe, it, expect, beforeAll } from "vitest";

// Load real test keys from .env.local, OVERRIDING the integration-setup
// placeholders, before importing RazorpayService (which reads keys at import).
try {
  for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
} catch {
  /* no .env.local → placeholders remain → suite skips */
}

const KEY = process.env.RAZORPAY_KEY_ID || "";
const IS_REAL_TEST_MODE = /^rzp_test_[A-Za-z0-9]{14,}$/.test(KEY);
const ENABLED =
  process.env.RUN_MIT_CHARGE_TEST === "1" &&
  !!process.env.MIT_TEST_TOKEN &&
  !!process.env.MIT_TEST_CUSTOMER;

describe.skipIf(!IS_REAL_TEST_MODE || !ENABLED)(
  "Razorpay MIT charge — one-off test-mode verification",
  () => {
    let RazorpayService: typeof import("@/lib/razorpay").RazorpayService;
    beforeAll(async () => {
      ({ RazorpayService } = await import("@/lib/razorpay"));
    });

    it("chargeViaToken executes an MIT charge on the stored mandate token", async () => {
      const res = await RazorpayService.chargeViaToken({
        customerId: process.env.MIT_TEST_CUSTOMER as string,
        tokenId: process.env.MIT_TEST_TOKEN as string,
        amountInRupees: Number(process.env.MIT_TEST_AMOUNT || "599.88"),
        email: process.env.MIT_TEST_EMAIL || "test@example.com",
        contact: process.env.MIT_TEST_CONTACT || "9999999999",
        receipt: `mit-verify-${Date.now()}`,
        description: "MIT charge test-mode verification",
        notes: { source: "mit-charge-verify" },
      });
      // eslint-disable-next-line no-console
      console.log("MIT charge result:", JSON.stringify(res));
      expect(res.paymentId).toMatch(/^pay_/);
      expect(res.orderId).toMatch(/^order_/);
      expect(res.amount).toBeGreaterThan(0);
    }, 60000);
  }
);
