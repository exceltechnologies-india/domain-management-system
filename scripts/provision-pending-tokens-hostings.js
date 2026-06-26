#!/usr/bin/env node
/**
 * scripts/provision-pending-tokens-hostings.js — Tokens-flow DA-provisioning cron.
 *
 * After Phase 2C creates a Hosting row in status='pending' with an empty
 * directAdminUsername, this cron picks it up + creates the actual DA user
 * account. On success the Hosting flips to status='active' and the
 * customer's trial is usable.
 *
 * Designed for Cloud Scheduler — invoke every 5-15 min so customers
 * complete the trial signup → DA-account-ready flow within minutes.
 * Idempotent: re-running the cron on already-provisioned Hostings
 * skips them via the directAdminUsername-empty check in the query.
 *
 * The real business logic lives in
 * lib/services/payment/tokens-da-provisioner.ts; this file is the thin
 * CLI wrapper, like Phase 2D's `scripts/charge-recurring-hostings.js`.
 *
 * Usage:
 *   node scripts/provision-pending-tokens-hostings.js
 *
 * Safety:
 *   - Refuses to run unless HOSTING_MANDATE_FLOW=tokens (defensive
 *     guard — no Hostings would have razorpayTokenId set otherwise,
 *     so the query would always return empty)
 *   - Per-Hosting errors don't block the batch — log + continue
 *   - DA-unreachable + collision-exhausted + hard-failure all leave
 *     Hosting status='pending' so the next cron run retries
 */
require("dotenv").config({ path: ".env.local" });
const mongoose = require("mongoose");

if (process.env.HOSTING_MANDATE_FLOW !== "tokens") {
  console.warn(
    `⚠ HOSTING_MANDATE_FLOW is '${process.env.HOSTING_MANDATE_FLOW || "(unset)"}', not 'tokens' — no Hostings would have razorpayTokenId set, so this cron would no-op. Exiting.`
  );
  process.exit(0);
}

if (!process.env.MONGODB_URI) {
  console.error("✗ MONGODB_URI is unset in .env.local");
  process.exit(1);
}

async function main() {
  console.log("─── Tokens-flow DA-provisioning cron ───");
  console.log("");

  const { findPendingTokensFlowHostings, provisionTokensFlowHosting } =
    await import("../lib/services/payment/tokens-da-provisioner.ts");

  await mongoose.connect(process.env.MONGODB_URI);
  console.log("✓ MongoDB connected");

  const pending = await findPendingTokensFlowHostings({ limit: 100 });
  console.log(`Found ${pending.length} Hostings pending DA provisioning`);
  if (pending.length === 0) {
    await mongoose.disconnect();
    return;
  }

  let activated = 0;
  let skipped = 0;
  let daUnreachable = 0;
  let collisionExhausted = 0;
  let hardFailure = 0;

  for (const hosting of pending) {
    try {
      const result = await provisionTokensFlowHosting(hosting);
      const tag =
        result.outcome === "activated"
          ? "✅"
          : result.outcome === "skipped"
            ? "·"
            : result.outcome === "da_unreachable"
              ? "⚠️"
              : "❌";
      console.log(
        `${tag} ${result.domainName.padEnd(30)} ${result.outcome.padEnd(22)} ${result.reason ? "— " + result.reason : result.daUsername ? "→ " + result.daUsername : ""}`
      );
      switch (result.outcome) {
        case "activated":
          activated += 1;
          break;
        case "skipped":
          skipped += 1;
          break;
        case "da_unreachable":
          daUnreachable += 1;
          break;
        case "collision_exhausted":
          collisionExhausted += 1;
          break;
        case "hard_failure":
          hardFailure += 1;
          break;
      }
    } catch (err) {
      console.error(
        `✗ ${hosting.domainName}: unexpected error — ${err && err.message ? err.message : err}`
      );
    }
  }

  console.log("");
  console.log("─── Summary ───");
  console.log(`  Activated:           ${activated}`);
  console.log(`  Skipped:             ${skipped}`);
  console.log(`  DA unreachable:      ${daUnreachable}  (will retry next run)`);
  console.log(`  Collision exhausted: ${collisionExhausted}`);
  console.log(`  Hard failure:        ${hardFailure}`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("\n✗ ERROR:", err && err.message ? err.message : err);
  if (err && err.stack) console.error(err.stack);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(99);
});
