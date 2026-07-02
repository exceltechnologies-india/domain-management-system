#!/usr/bin/env node
/**
 * scripts/provision-pending-tokens-hostings.js — DA-provisioning cron.
 *
 * FLOW-AGNOSTIC as of 2026-07-02: picks up any Hosting row in
 * status='pending' with an empty directAdminUsername, regardless of
 * whether it came from the Tokens flow (has razorpayTokenId), Manual
 * flow (no razorpayTokenId, billingType='manual'), or a future flow
 * that reuses the same "pending DA-await" shape. The old
 * razorpayTokenId filter + HOSTING_MANDATE_FLOW='tokens' guard were
 * removed after Manual-flow trials went live 2026-06-29 — leaving
 * them in place caused every Manual-flow trial signup to sit in
 * status='pending' forever. See TASKS.md
 * MANUAL-FLOW-TRIAL-VERIFIED-END-TO-END → Gap B for the incident.
 *
 * On success the Hosting flips to status='active' and the customer's
 * trial is usable. The welcome-email mandateMode is now derived from
 * `hosting.razorpayTokenId` / `hosting.billingType` so Tokens-flow
 * signups get the 1-attempt-suspension callout and Manual-flow signups
 * get the day-15 manual-payment reminder — messaging accurate to each
 * signup path.
 *
 * Designed for Cloud Scheduler — invoke every 5-15 min so customers
 * complete the trial signup → DA-account-ready flow within minutes.
 * Idempotent: re-running the cron on already-provisioned Hostings
 * skips them via the directAdminUsername-empty check in the query.
 *
 * The real business logic lives in
 * lib/services/payment/tokens-da-provisioner.ts; this file is the thin
 * CLI wrapper, like Phase 2D's `scripts/charge-recurring-hostings.js`.
 * The `TokensFlow` in the module name is a legacy artifact of when only
 * that flow was in scope — its behavior is now flow-agnostic (see the
 * module's docstring for the rename note).
 *
 * Usage:
 *   node scripts/provision-pending-tokens-hostings.js
 *
 * Safety:
 *   - Per-Hosting errors don't block the batch — log + continue
 *   - DA-unreachable + collision-exhausted + hard-failure all leave
 *     Hosting status='pending' so the next cron run retries
 */
require("dotenv").config({ path: ".env.local" });
const mongoose = require("mongoose");

if (!process.env.MONGODB_URI) {
  console.error("✗ MONGODB_URI is unset in .env.local");
  process.exit(1);
}

async function main() {
  console.log("─── Flow-agnostic DA-provisioning cron ───");
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
