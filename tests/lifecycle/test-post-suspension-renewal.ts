/**
 * tests/lifecycle/test-post-suspension-renewal.ts
 *
 * Scenario: Customer pays AFTER suspension (worst case — fully suspended).
 * Expected: status = 'active', expiryDate = now + plan duration.
 *           DA unsuspend called (tested via status change since DA is mocked in test env).
 *           processing_until = null, last_reminder_sent = null.
 *           RenewalPayment.processed = true.
 *
 * Usage: npx ts-node -r tsconfig-paths/register tests/lifecycle/test-post-suspension-renewal.ts
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

  // ── Seed: fully suspended hosting ────────────────────────────────────────
  const pastExpiry = new Date();
  pastExpiry.setDate(pastExpiry.getDate() - 5); // Expired 5 days ago

  const TEST_DOMAIN = `test-suspended-${Date.now()}.example.com`;
  const hosting = await Hosting.create({
    userId: testUser._id,
    domainName: TEST_DOMAIN,
    planId: "basic",
    name: "Basic Plan",
    serverPackage: "basic_pkg",
    status: "suspended",
    startDate: new Date(pastExpiry.getTime() - 30 * 24 * 60 * 60 * 1000),
    expiryDate: pastExpiry,
    next_action_at: null,
    last_reminder_sent: -1,
    directAdminUsername: "testuser3",
    orderId: `ORD-TEST-${Date.now()}`,
    autoRenew: false,
  });

  console.log(`✅ Seeded suspended hosting: ${TEST_DOMAIN}`);

  const fakePaymentId = `pay_TEST_SUSP_${Date.now()}`;
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
  const now = new Date();
  let passed = true;

  if (!updated) {
    console.error("❌ Hosting not found after webhook");
    passed = false;
  } else {
    // Status must be active
    if (updated.status !== "active") {
      console.error(`❌ status should be 'active', got '${updated.status}'`);
      passed = false;
    } else {
      console.log("✅ status = active (Payment Always Wins ✓)");
    }

    // Expiry must be fresh (not extending from old expired date)
    const minExpected = new Date(now);
    minExpected.setDate(minExpected.getDate() + 25);
    if (updated.expiryDate < minExpected) {
      console.error(`❌ expiryDate not properly reset: ${updated.expiryDate.toISOString()}`);
      passed = false;
    } else {
      console.log(`✅ expiryDate reset to: ${updated.expiryDate.toISOString()}`);
    }

    if (updated.last_reminder_sent !== null) {
      console.error(`❌ last_reminder_sent should be null, got ${updated.last_reminder_sent}`);
      passed = false;
    } else {
      console.log("✅ last_reminder_sent = null");
    }

    if (updated.processing_until !== null) {
      console.error(`❌ processing_until should be null`);
      passed = false;
    } else {
      console.log("✅ processing_until = null");
    }

    // next_action_at should be approximately 7 days before new expiry
    if (!updated.next_action_at) {
      console.error("❌ next_action_at is not set");
      passed = false;
    } else {
      const expectedNextAction = new Date(updated.expiryDate.getTime() - 7 * 24 * 60 * 60 * 1000);
      const diff = Math.abs(updated.next_action_at.getTime() - expectedNextAction.getTime());
      if (diff > 60000) { // Allow 1 minute variance
        console.error(`❌ next_action_at mismatched: ${updated.next_action_at.toISOString()}`);
        passed = false;
      } else {
        console.log(`✅ next_action_at = expiry - 7 days: ${updated.next_action_at.toISOString()}`);
      }
    }
  }

  if (!renewal?.processed) {
    console.error("❌ RenewalPayment not processed");
    passed = false;
  } else {
    console.log("✅ RenewalPayment.processed = true");
  }

  // Cleanup
  await Hosting.deleteOne({ _id: hosting._id });
  await RenewalPayment.deleteOne({ providerPaymentId: fakePaymentId });
  await User.deleteOne({ email: "test-lifecycle@example.com" });
  console.log("🧹 Cleanup done");

  await mongoose.disconnect();
  console.log(passed
    ? "\n✅ TEST PASSED: Post-Suspension Renewal"
    : "\n❌ TEST FAILED: Post-Suspension Renewal"
  );
  process.exit(passed ? 0 : 1);
}

run().catch(console.error);
