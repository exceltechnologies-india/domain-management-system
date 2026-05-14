/**
 * tests/lifecycle/test-post-expiry-renewal.ts
 *
 * Scenario: Customer pays AFTER expiry but service is still in 'grace' status.
 * Expected: expiryDate = now + plan duration (hard reset, not add-on).
 *           status = 'active'.
 *           last_reminder_sent = null, processing_until = null.
 *           RenewalPayment.processed = true.
 *
 * Usage: npx ts-node -r tsconfig-paths/register tests/lifecycle/test-post-expiry-renewal.ts
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

  // ── Seed: expired hosting in grace period ────────────────────────────────
  const pastExpiry = new Date();
  pastExpiry.setDate(pastExpiry.getDate() - 2); // Expired 2 days ago

  const graceEndsAt = new Date();
  graceEndsAt.setDate(graceEndsAt.getDate() + 1); // Grace ends tomorrow

  const TEST_DOMAIN = `test-postexpiry-${Date.now()}.example.com`;
  const hosting = await Hosting.create({
    userId: testUser._id,
    domainName: TEST_DOMAIN,
    planId: "basic",
    name: "Basic Plan",
    serverPackage: "basic_pkg",
    status: "grace",
    startDate: new Date(pastExpiry.getTime() - 30 * 24 * 60 * 60 * 1000),
    expiryDate: pastExpiry,
    next_action_at: graceEndsAt,
    last_reminder_sent: 1,
    directAdminUsername: "testuser2",
    orderId: `ORD-TEST-${Date.now()}`,
    autoRenew: true,
  });

  console.log(`✅ Seeded hosting in grace: ${TEST_DOMAIN}, expired=${pastExpiry.toISOString()}`);

  const fakePaymentId = `pay_TEST_POSTEXP_${Date.now()}`;
  const webhookBody = JSON.stringify({
    event: "subscription.charged",
    payload: {
      payment: {
        entity: {
          id: fakePaymentId,
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

  console.log("📡 Sending webhook...");
  const resp = await fetch(`${BASE_URL}/api/webhooks/razorpay`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-razorpay-signature": sig,
    },
    body: webhookBody,
  });

  console.log("📡 Webhook response:", resp.status, await resp.json());
  await new Promise((r) => setTimeout(r, 500));

  const updated = await Hosting.findById(hosting._id);
  const renewal = await RenewalPayment.findOne({ providerPaymentId: fakePaymentId });

  let passed = true;
  const now = new Date();

  if (!updated) {
    console.error("❌ Hosting not found");
    passed = false;
  } else {
    if (updated.status !== "active") {
      console.error(`❌ status should be 'active', got '${updated.status}'`);
      passed = false;
    } else {
      console.log("✅ status = active");
    }

    // Expiry should be roughly now + 1 month (hard reset, not extending from past)
    const expectedMinExpiry = new Date(now);
    expectedMinExpiry.setDate(expectedMinExpiry.getDate() + 25); // At least 25 days out
    if (updated.expiryDate < expectedMinExpiry) {
      console.error(`❌ expiryDate not hard-reset: ${updated.expiryDate.toISOString()}`);
      passed = false;
    } else {
      console.log(`✅ expiryDate hard-reset: ${updated.expiryDate.toISOString()}`);
    }

    if (updated.last_reminder_sent !== null) {
      console.error(`❌ last_reminder_sent should be null, got ${updated.last_reminder_sent}`);
      passed = false;
    } else {
      console.log("✅ last_reminder_sent = null");
    }
  }

  if (!renewal?.processed) {
    console.error("❌ RenewalPayment not processed");
    passed = false;
  } else {
    console.log("✅ RenewalPayment.processed = true");
  }

  await Hosting.deleteOne({ _id: hosting._id });
  await RenewalPayment.deleteOne({ providerPaymentId: fakePaymentId });
  await User.deleteOne({ email: "test-lifecycle@example.com" });
  console.log("🧹 Cleanup done");

  await mongoose.disconnect();
  console.log(passed ? "\n✅ TEST PASSED: Post-Expiry Renewal" : "\n❌ TEST FAILED: Post-Expiry Renewal");
  process.exit(passed ? 0 : 1);
}

run().catch(console.error);
