/**
 * tests/lifecycle/test-duplicate-webhook.ts
 *
 * Scenario: The SAME Razorpay webhook is delivered TWICE (race condition / retry).
 * Expected: Only ONE RenewalPayment record exists (unique index blocks double-insert).
 *           Service expiryDate extended exactly ONCE, not twice.
 *           RenewalPayment.processed = true with a single processedAt timestamp.
 *
 * Usage: npx ts-node -r tsconfig-paths/register tests/lifecycle/test-duplicate-webhook.ts
 */
import mongoose from "mongoose";
import Hosting from "../../models/Hosting";
import RenewalPayment from "../../models/RenewalPayment";
import User from "../../models/User";
import crypto from "crypto";

require("dotenv").config({ path: ".env.local" });

const BASE_URL = process.env.NEXTAUTH_URL || "http://localhost:3000";
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "test_secret";

async function run() {
  await mongoose.connect(process.env.MONGODB_URI!);
  console.log("✅ Connected to DB");

  const testUser = await User.findOneAndUpdate(
    { email: "test-lifecycle@example.com" },
    {
      $setOnInsert: {
        email: "test-lifecycle@example.com",
        firstName: "Test",
        lastName: "User",
        password: "not-real",
        isEmailVerified: true,
      },
    },
    { upsert: true, new: true }
  );

  // ── Seed: active hosting, expires in 5 days ──────────────────────────────
  const originalExpiry = new Date();
  originalExpiry.setDate(originalExpiry.getDate() + 5);

  const TEST_DOMAIN = `test-duplicate-${Date.now()}.example.com`;
  const hosting = await Hosting.create({
    userId: testUser._id,
    domainName: TEST_DOMAIN,
    planId: "basic",
    name: "Basic Plan",
    serverPackage: "basic_pkg",
    status: "expiring_soon",
    startDate: new Date(),
    expiryDate: originalExpiry,
    last_reminder_sent: 7,
    directAdminUsername: "testuser4",
    orderId: `ORD-TEST-${Date.now()}`,
    autoRenew: true,
  });

  console.log(`✅ Seeded hosting: ${TEST_DOMAIN}, expiry=${originalExpiry.toISOString()}`);

  // ── Build the SAME webhook payload (same paymentId) ──────────────────────
  const SAME_PAYMENT_ID = `pay_TEST_DUP_${Date.now()}`;
  const webhookBody = JSON.stringify({
    event: "subscription.charged",
    payload: {
      payment: {
        entity: {
          id: SAME_PAYMENT_ID,
          amount: 50000,
          currency: "INR",
          order_id: `order_test_${Date.now()}`,
        },
      },
      subscription: {
        entity: {
          id: `sub_test_${Date.now()}`,
          plan_id: "plan_monthly_test",
          notes: {
            user_id: testUser._id.toString(),
            domain_name: TEST_DOMAIN,
          },
        },
      },
    },
  });

  const sig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(webhookBody).digest("hex");
  const headers = {
    "Content-Type": "application/json",
    "x-razorpay-signature": sig,
  };

  // ── Send the webhook TWICE (simulating Razorpay retry) ───────────────────
  console.log("📡 Sending webhook #1...");
  const resp1 = await fetch(`${BASE_URL}/api/webhooks/razorpay`, {
    method: "POST",
    headers,
    body: webhookBody,
  });
  console.log("📡 Response #1:", resp1.status, await resp1.json());

  // Short delay to simulate realistic retry interval
  await new Promise((r) => setTimeout(r, 300));

  console.log("📡 Sending webhook #2 (duplicate)...");
  const resp2 = await fetch(`${BASE_URL}/api/webhooks/razorpay`, {
    method: "POST",
    headers,
    body: webhookBody,
  });
  console.log("📡 Response #2:", resp2.status, await resp2.json());

  await new Promise((r) => setTimeout(r, 500));

  // ── Assertions ────────────────────────────────────────────────────────────
  const renewalCount = await RenewalPayment.countDocuments({
    providerPaymentId: SAME_PAYMENT_ID,
  });
  const renewal = await RenewalPayment.findOne({ providerPaymentId: SAME_PAYMENT_ID });
  const updated = await Hosting.findById(hosting._id);

  let passed = true;

  // Exactly ONE RenewalPayment record
  if (renewalCount !== 1) {
    console.error(`❌ Expected 1 RenewalPayment, found ${renewalCount}`);
    passed = false;
  } else {
    console.log("✅ Exactly 1 RenewalPayment record (no duplicates)");
  }

  if (!renewal?.processed) {
    console.error("❌ RenewalPayment not marked processed");
    passed = false;
  } else {
    console.log("✅ RenewalPayment.processed = true");
  }

  if (!updated) {
    console.error("❌ Hosting not found");
    passed = false;
  } else {
    // expiryDate should be extended exactly ONCE (original + ~1 month)
    const oneMonthFromOriginal = new Date(originalExpiry);
    oneMonthFromOriginal.setMonth(oneMonthFromOriginal.getMonth() + 1);

    const twoMonthsFromOriginal = new Date(originalExpiry);
    twoMonthsFromOriginal.setMonth(twoMonthsFromOriginal.getMonth() + 2);

    if (updated.expiryDate >= twoMonthsFromOriginal) {
      console.error(
        `❌ expiryDate extended TWICE: ${updated.expiryDate.toISOString()} (should stop at ~${oneMonthFromOriginal.toISOString()})`
      );
      passed = false;
    } else if (updated.expiryDate >= oneMonthFromOriginal) {
      console.log(`✅ expiryDate extended exactly once: ${updated.expiryDate.toISOString()}`);
    } else {
      console.error(`❌ expiryDate not extended at all: ${updated.expiryDate.toISOString()}`);
      passed = false;
    }
  }

  // Cleanup
  await Hosting.deleteOne({ _id: hosting._id });
  await RenewalPayment.deleteMany({ providerPaymentId: SAME_PAYMENT_ID });
  await User.deleteOne({ email: "test-lifecycle@example.com" });
  console.log("🧹 Cleanup done");

  await mongoose.disconnect();
  console.log(passed
    ? "\n✅ TEST PASSED: Duplicate Webhook Idempotency"
    : "\n❌ TEST FAILED: Duplicate Webhook Idempotency"
  );
  process.exit(passed ? 0 : 1);
}

run().catch(console.error);
