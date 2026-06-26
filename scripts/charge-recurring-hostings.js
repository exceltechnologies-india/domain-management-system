#!/usr/bin/env node
/**
 * scripts/charge-recurring-hostings.js — Tokens-flow MIT charging cron.
 *
 * Finds hostings whose expiry is within the lookahead window AND have a
 * stored mandate token, then fires the recurring debit via the stored
 * token. Idempotent — safe to run on any cadence; the unique index on
 * (hostingId, dueDate) in RecurringChargeAttempt ensures one charge
 * per billing cycle regardless of cron-firing schedule.
 *
 * Designed to be invoked from Cloud Scheduler daily at ~04:00 IST. The
 * actual business logic lives in lib/services/payment/recurring-charge-service.ts
 * (testable in isolation); this file is the thin CLI wrapper.
 *
 * Usage:
 *   node scripts/charge-recurring-hostings.js              # dry-run (default — no Razorpay calls, no DB writes)
 *   node scripts/charge-recurring-hostings.js --apply      # real charges + DB writes
 *
 * Safety:
 *   - Refuses to run unless RAZORPAY_KEY_ID starts with `rzp_live_`
 *     (when --apply is set) — pure dry-run mode allowed against any env.
 *   - Refuses to run unless HOSTING_MANDATE_FLOW === 'tokens' — this
 *     cron is a no-op when the feature flag is off, because no Hostings
 *     would have razorpayTokenId set anyway. Defensive guard.
 *   - Logs each hosting's outcome inline (one line per row).
 *   - On Razorpay/DB error mid-batch: continues to the next hosting
 *     (failure of one mandate must not block the next customer's charge).
 */
require("dotenv").config({ path: ".env.local" });
const mongoose = require("mongoose");

const APPLY = process.argv.includes("--apply");

if (APPLY) {
  const keyId = process.env.RAZORPAY_KEY_ID || "";
  if (!keyId.startsWith("rzp_live_")) {
    console.error(
      `✗ Refusing to run with --apply: RAZORPAY_KEY_ID is '${keyId.substring(0, 12)}…', expected to start with 'rzp_live_'`
    );
    process.exit(1);
  }
}

if (process.env.HOSTING_MANDATE_FLOW !== "tokens") {
  console.warn(
    `⚠ HOSTING_MANDATE_FLOW is '${process.env.HOSTING_MANDATE_FLOW || "(unset)"}', not 'tokens' — no Hostings will have razorpayTokenId set, so this cron would no-op. Exiting.`
  );
  process.exit(0);
}

if (!process.env.MONGODB_URI) {
  console.error("✗ MONGODB_URI is unset in .env.local");
  process.exit(1);
}

async function main() {
  console.log(`─── Tokens-flow recurring charge cron ───`);
  console.log(`  Mode: ${APPLY ? "APPLY (real Razorpay charges + DB writes)" : "DRY-RUN (no writes)"}`);
  console.log("");

  // Lazy-load to avoid pulling Mongoose into the env-validation phase
  const { findHostingsDueForCharge, chargeRecurringHosting } = await import(
    "../lib/services/payment/recurring-charge-service.ts"
  );

  await mongoose.connect(process.env.MONGODB_URI);
  console.log("✓ MongoDB connected");

  const due = await findHostingsDueForCharge({ limit: 100 });
  console.log(`Found ${due.length} hostings due for recurring charge`);
  if (due.length === 0) {
    await mongoose.disconnect();
    return;
  }

  let succeeded = 0;
  let retryScheduled = 0;
  let abandoned = 0;
  let skipped = 0;

  for (const hosting of due) {
    try {
      const result = await chargeRecurringHosting(hosting, { dryRun: !APPLY });
      const tag =
        result.outcome === "succeeded"
          ? "✅"
          : result.outcome === "retry_scheduled"
            ? "⚠️"
            : result.outcome === "abandoned"
              ? "❌"
              : "·";
      console.log(
        `${tag} ${result.domainName.padEnd(30)} ${result.outcome.padEnd(18)} attempt=${result.attemptCount} ${result.reason ? "— " + result.reason : ""}`
      );
      if (result.outcome === "succeeded") succeeded += 1;
      else if (result.outcome === "retry_scheduled") retryScheduled += 1;
      else if (result.outcome === "abandoned") abandoned += 1;
      else skipped += 1;
    } catch (err) {
      // Per-hosting error must not block the rest of the batch
      console.error(
        `✗ ${hosting.domainName}: unexpected error — ${err && err.message ? err.message : err}`
      );
    }
  }

  console.log("");
  console.log(`─── Summary ───`);
  console.log(`  Succeeded:       ${succeeded}`);
  console.log(`  Retry scheduled: ${retryScheduled}`);
  console.log(`  Abandoned:       ${abandoned}`);
  console.log(`  Skipped:         ${skipped}`);
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
