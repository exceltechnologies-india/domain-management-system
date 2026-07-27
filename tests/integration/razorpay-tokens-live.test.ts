/**
 * Razorpay Tokens flow — LIVE integration tests against Razorpay TEST mode.
 *
 * This is Phase 3 of the Tokens migration (docs/razorpay-tokens-migration.md
 * §6): "End-to-end against Razorpay TEST mode … verifies the actual Razorpay
 * APIs match our code's assumptions." Unlike the other integration tests
 * (which mock the Razorpay SDK), this file makes REAL calls to Razorpay's
 * test API using the test keys in .env.local, exercising our own
 * `RazorpayService` methods.
 *
 * Auto-skips when real test keys aren't present (CI, or the integration
 * setup's placeholder `rzp_test_keyid`), so it never fails a keyless run.
 *
 * Covers the API-callable legs of the CIT flow:
 *   - createCustomer (+ idempotency on duplicate email)
 *   - createRecurringTokenOrder (the ₹2 mandate-auth order with token config)
 *   - verifyWebhookSignature against the active webhook secret
 *
 * The interactive legs (mandate AUTHORIZATION → token capture → ₹2 refund →
 * MIT charge) require the Razorpay Checkout overlay + a test instrument
 * (success@razorpay / 4111…), so they stay as the manual/UI test (§5.3) —
 * this suite proves the server-side API contract our webhook + cron rely on.
 */
import fs from 'fs';
import { describe, it, expect, beforeAll } from 'vitest';

// Load real test keys from .env.local, OVERRIDING the setup.ts placeholders,
// before we dynamically import RazorpayService (which reads keys at import).
try {
  for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
} catch {
  /* no .env.local (CI) → placeholders remain → suite skips below */
}

const KEY = process.env.RAZORPAY_KEY_ID || '';
// Real Razorpay test key ids look like rzp_test_XXXXXXXXXXXXXX (14+ chars after
// the prefix). The integration-setup placeholder is 'rzp_test_keyid' (5) — skip.
const IS_REAL_TEST_MODE = /^rzp_test_[A-Za-z0-9]{14,}$/.test(KEY);

describe.skipIf(!IS_REAL_TEST_MODE)('Razorpay Tokens flow — live against test-mode API', () => {
  let RazorpayService: typeof import('@/lib/razorpay').RazorpayService;
  let customerId = '';
  const runId = Date.now();

  beforeAll(async () => {
    ({ RazorpayService } = await import('@/lib/razorpay'));
  });

  it('createCustomer → returns a cust_ id', async () => {
    const email = `phase3-tokens-${runId}@example.com`;
    const c = await RazorpayService.createCustomer({
      name: 'Phase3 Tokens Test',
      email,
      contact: '9999999999',
      notes: { source: 'phase3-integration-test' },
    });
    expect(c.id).toMatch(/^cust_/);
    expect(c.email).toBe(email);
    customerId = c.id;

    // Idempotency: fail_existing:0 means a repeat with the same email returns
    // a valid customer rather than throwing (our code relies on this).
    const again = await RazorpayService.createCustomer({
      name: 'Phase3 Tokens Test',
      email,
      contact: '9999999999',
    });
    expect(again.id).toMatch(/^cust_/);
  }, 30_000);

  it('createRecurringTokenOrder → ₹2 mandate-auth order with recurring token config', async () => {
    expect(customerId).toMatch(/^cust_/);
    const order = await RazorpayService.createRecurringTokenOrder({
      customerId,
      validationAmountInPaise: 200, // ₹2
      maxAmountInPaise: 224640, // Plus yearly (₹2246.40) — largest tier
      frequency: 'as_presented',
      receipt: `phase3-${runId}`.slice(0, 40),
      notes: { type: 'hosting_trial', source: 'phase3-integration-test' },
    });

    // The contract our webhook (handleMandateValidationCaptured) + provisioner
    // assume about the created order. NOTE: Razorpay's order-create response
    // does NOT echo `customer_id` at the top level (our webhook reads our own
    // stored `razorpayCustomerId`, not the order's) — so we don't assert it.
    expect(order.id).toMatch(/^order_/);
    expect(order.amount).toBe(200);
    expect(order.currency).toBe('INR');
    expect((order as unknown as { status?: string }).status).toBe('created');
  }, 30_000);

  it('createRecurringTokenOrder → rejects a sub-₹1 validation amount', async () => {
    await expect(
      RazorpayService.createRecurringTokenOrder({
        customerId,
        validationAmountInPaise: 50, // below the 100-paise floor
        maxAmountInPaise: 224640,
        receipt: `phase3-bad-${runId}`.slice(0, 40),
      }),
    ).rejects.toThrow();
  });

  it('verifyWebhookSignature → true for a correctly-signed body, false when tampered', async () => {
    const crypto = await import('crypto');
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET || '';
    expect(secret.length).toBeGreaterThan(0);
    const body = JSON.stringify({ event: 'payment.captured', created_at: Math.floor(runId / 1000) });
    const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
    expect(RazorpayService.verifyWebhookSignature(body, sig, secret)).toBe(true);
    expect(RazorpayService.verifyWebhookSignature(body + 'x', sig, secret)).toBe(false);
    expect(RazorpayService.verifyWebhookSignature(body, sig, secret + 'x')).toBe(false);
  });
});
