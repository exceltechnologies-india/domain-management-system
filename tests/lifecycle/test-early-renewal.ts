/**
 * tests/lifecycle/test-early-renewal.ts
 *
 * Scenario: Customer pays BEFORE expiry (service is active/expiring_soon).
 * Expected: expiryDate extended by plan duration from current expiry (add-on model).
 *           last_reminder_sent reset to null.
 *           next_action_at set to new_expiry - 7 days.
 *           RenewalPayment.processed = true.
 *
 * Usage: npx ts-node -r tsconfig-paths/register tests/lifecycle/test-early-renewal.ts
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

  // ── Seed: test user ──────────────────────────────────────────────────────
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

  // ── Seed: test hosting (active, expires in 5 days) ───────────────────────
  const futureExpiry = new Date();
  futureExpiry.setDate(futureExpiry.getDate() + 5);

  const TEST_DOMAIN = `test-early-${Date.now()}.example.com`;
  const hosting = await Hosting.create({
    userId: testUser._id,
    domainName: TEST_DOMAIN,
    planId: "basic",
    name: "Basic Plan",
    serverPackage: "basic_pkg",
    status: "expiring_soon",
    startDate: new Date(),
    expiryDate: futureExpiry,
    last_reminder_sent: 7,
    next_action_at: new Date(futureExpiry.getTime() - 3 * 24 * 60 * 60 * 1000),
    directAdminUsername: "testuser1",
    orderId: `ORD-TEST-${Date.now()}`,
    autoRenew: true,
  });

  console.log(`✅ Seeded hosting: ${TEST_DOMAIN}, expiry=${futureExpiry.toISOString()}`);

  // ── Build fake Razorpay webhook payload ──────────────────────────────────
  const fakePaymentId = `pay_TEST_EARLY_${Date.now()}`;
  const webhookBody = JSON.stringify({
    event: "subscription.charged",
    payload: {
      payment: {
        entity: {
          id: fakePaymentId,
          amount: 50000, // ₹500 in paise
          currency: "INR",
          order_id: `order_test_${Date.now()}`,
        },
      },
      subscription: {
        entity: {
          id: `sub_test_${Date.now()}`,
          plan_id: "plan_monthly_test", // Adjust to match a real plan in your DB if needed
          notes: {
            user_id: testUser._id.toString(),
            domain_name: TEST_DOMAIN,
          },
        },
      },
    },
  });

  const hmac = crypto.createHmac("sha256", WEBHOOK_SECRET);
  hmac.update(webhookBody);
  const signature = hmac.digest("hex");

  // ── Call the webhook ──────────────────────────────────────────────────────
  console.log("📡 Sending webhook...");
  const resp = await fetch(`${BASE_URL}/api/webhooks/razorpay`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-razorpay-signature": signature,
    },
    body: webhookBody,
  });

  const result = await resp.json();
  console.log("📡 Webhook response:", resp.status, result);

  // ── Assertions ────────────────────────────────────────────────────────────
  await new Promise((r) => setTimeout(r, 500)); // Brief wait for async saves

  const updated = await Hosting.findById(hosting._id);
  const renewal = await RenewalPayment.findOne({ providerPaymentId: fakePaymentId });

  let passed = true;

  if (!updated) {
    console.error("❌ Hosting not found after webhook");
    passed = false;
  } else {
    if (updated.status !== "active") {
      console.error(`❌ status should be 'active', got '${updated.status}'`);
      passed = false;
    } else {
      console.log("✅ status = active");
    }

    if (updated.last_reminder_sent !== null) {
      console.error(`❌ last_reminder_sent should be null, got ${updated.last_reminder_sent}`);
      passed = false;
    } else {
      console.log("✅ last_reminder_sent = null");
    }

    const expectedMinExpiry = new Date(futureExpiry);
    expectedMinExpiry.setMonth(expectedMinExpiry.getMonth() + 1);
    if (updated.expiryDate < expectedMinExpiry) {
      console.error(`❌ expiryDate not extended. Got ${updated.expiryDate.toISOString()}, expected >= ${expectedMinExpiry.toISOString()}`);
      passed = false;
    } else {
      console.log(`✅ expiryDate extended: ${updated.expiryDate.toISOString()}`);
    }
  }

  if (!renewal || !renewal.processed) {
    console.error("❌ RenewalPayment not marked processed");
    passed = false;
  } else {
    console.log("✅ RenewalPayment.processed = true");
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await Hosting.deleteOne({ _id: hosting._id });
  await RenewalPayment.deleteOne({ providerPaymentId: fakePaymentId });
  await User.deleteOne({ email: "test-lifecycle@example.com" });
  console.log("🧹 Cleanup done");

  await mongoose.disconnect();
  console.log(passed ? "\n✅ TEST PASSED: Early Renewal" : "\n❌ TEST FAILED: Early Renewal");
  process.exit(passed ? 0 : 1);
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
