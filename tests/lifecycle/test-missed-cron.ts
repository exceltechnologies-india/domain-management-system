/**
 * tests/lifecycle/test-missed-cron.ts
 *
 * Scenario: The cron job was NOT run for 1 day (simulated by setting next_action_at
 *           to yesterday). When the scheduler runs TODAY, it must still pick up and
 *           process all overdue services — not just "today's" services.
 *
 * Expected: All seeded services (with overdue next_action_at) are queued.
 *           Scheduler result shows queuedHostings >= number of seeded services.
 *           Services have processing_until set (locked by scheduler).
 *
 * Usage: npx ts-node -r tsconfig-paths/register tests/lifecycle/test-missed-cron.ts
 */
import mongoose from "mongoose";
import Hosting from "../../models/Hosting";
import User from "../../models/User";

require("dotenv").config({ path: ".env.local" });

const BASE_URL = process.env.NEXTAUTH_URL || "http://localhost:3000";
const CRON_SECRET = process.env.CRON_SECRET || "";

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

  // ── Seed: 3 services where next_action_at was YESTERDAY ─────────────────
  const YESTERDAY = new Date();
  YESTERDAY.setDate(YESTERDAY.getDate() - 1);

  const TEST_DOMAINS = [
    `test-missed-1-${Date.now()}.example.com`,
    `test-missed-2-${Date.now()}.example.com`,
    `test-missed-3-${Date.now()}.example.com`,
  ];

  const seededIds: string[] = [];

  for (const domain of TEST_DOMAINS) {
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 7); // Expires in 7 days

    const h = await Hosting.create({
      userId: testUser._id,
      domainName: domain,
      planId: "basic",
      name: "Basic Plan",
      serverPackage: "basic_pkg",
      status: "active",
      startDate: new Date(),
      expiryDate,
      next_action_at: YESTERDAY, // OVERDUE — simulates missed cron
      last_reminder_sent: null,
      processing_until: null,   // Unlocked
      directAdminUsername: `testuser${Date.now()}`,
      orderId: `ORD-TEST-${Date.now()}`,
      autoRenew: true,
    });
    seededIds.push(h._id.toString());
    console.log(`✅ Seeded overdue hosting: ${domain} (next_action_at = yesterday)`);
  }

  // ── Call the scheduler ───────────────────────────────────────────────────
  console.log("\n📡 Calling daily scheduler...");
  const resp = await fetch(`${BASE_URL}/api/cron/daily-scheduler`, {
    method: "GET",
    headers: { "x-cron-secret": CRON_SECRET },
  });

  const result = await resp.json();
  console.log("📡 Scheduler response:", resp.status, JSON.stringify(result, null, 2));
  await new Promise((r) => setTimeout(r, 1000));

  // ── Assertions ────────────────────────────────────────────────────────────
  let passed = true;

  if (resp.status !== 200 || !result.data) {
    console.error("❌ Scheduler did not return a successful response");
    passed = false;
  } else {
    const { queuedHostings, skippedLocked, failed } = result.data;
    console.log(`\nScheduler stats: queued=${queuedHostings} skipped=${skippedLocked} failed=${failed}`);

    if (queuedHostings < TEST_DOMAINS.length) {
      console.error(
        `❌ Expected at least ${TEST_DOMAINS.length} hostings queued, got ${queuedHostings}`
      );
      passed = false;
    } else {
      console.log(`✅ All ${TEST_DOMAINS.length} overdue hostings were picked up (queued=${queuedHostings})`);
    }

    if (failed > 0) {
      console.error(`❌ ${failed} services failed to queue`);
      passed = false;
    }
  }

  // Verify services are now locked (processing_until set)
  const lockedCount = await Hosting.countDocuments({
    _id: { $in: seededIds },
    processing_until: { $ne: null, $exists: true },
  });

  if (lockedCount < TEST_DOMAINS.length) {
    console.error(
      `❌ Only ${lockedCount}/${TEST_DOMAINS.length} services have processing_until set`
    );
    passed = false;
  } else {
    console.log(`✅ All ${lockedCount} services locked (processing_until set)`);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await Hosting.deleteMany({ _id: { $in: seededIds } });
  await User.deleteOne({ email: "test-lifecycle@example.com" });
  console.log("🧹 Cleanup done");

  await mongoose.disconnect();
  console.log(passed
    ? "\n✅ TEST PASSED: Missed Cron Catch-Up"
    : "\n❌ TEST FAILED: Missed Cron Catch-Up"
  );
  process.exit(passed ? 0 : 1);
}

run().catch(console.error);
