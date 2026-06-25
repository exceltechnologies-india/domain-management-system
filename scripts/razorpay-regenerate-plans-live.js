#!/usr/bin/env node
/**
 * scripts/razorpay-regenerate-plans-live.js
 *
 * One-off: regenerate Razorpay subscription Plans for the 3 hosting tiers
 * (Starter / Standard / Plus) against LIVE mode and write the new IDs back to
 * HostingPlan.razorpayPlans. Mirrors the price-rotation logic from the admin
 * PATCH route at app/api/admin/hosting/packages/route.ts (monthly amount =
 * renewalPrice, yearly amount = renewalPrice * 12).
 *
 * Safety:
 *   - Refuses to run unless RAZORPAY_KEY_ID starts with `rzp_live_`.
 *   - Dry-run by default: prints the 3 tiers' current state + what would
 *     change. Re-run with --apply to actually create plans + write the DB.
 *   - In --apply mode: backs up the current 3 HostingPlan docs to a JSON
 *     file BEFORE any write, and refuses to overwrite an existing backup.
 *   - In --apply mode: creates all 6 Razorpay plans first (in-memory) and
 *     only touches the DB after all 6 succeed. So a Razorpay API failure
 *     mid-run leaves the DB untouched (some live plans may exist in the
 *     Razorpay dashboard but they're inert until a HostingPlan doc
 *     references their IDs).
 *
 * Usage:
 *   node scripts/razorpay-regenerate-plans-live.js              # dry-run
 *   node scripts/razorpay-regenerate-plans-live.js --apply      # do writes
 */

require('dotenv').config({ path: '.env.local' });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Razorpay = require('razorpay');

const APPLY = process.argv.includes('--apply');
const COMMERCIAL_TIER_NAMES = ['Starter', 'Standard', 'Plus'];
const BACKUP_FILE = path.join(
  __dirname,
  'razorpay-plans-pre-live-backup-2026-06-25.json'
);

// ── Safety: confirm live-mode credentials ──────────────────────────────────
const keyId = process.env.RAZORPAY_KEY_ID;
const keySecret = process.env.RAZORPAY_KEY_SECRET;
const mongoUri = process.env.MONGODB_URI;

if (!keyId || !keyId.startsWith('rzp_live_')) {
  console.error(
    `✗ Refusing to run: RAZORPAY_KEY_ID must start with 'rzp_live_' (got: ${
      keyId ? keyId.substring(0, 12) + '…' : '(unset)'
    })`
  );
  process.exit(1);
}
if (!keySecret) {
  console.error('✗ RAZORPAY_KEY_SECRET is unset in .env.local');
  process.exit(1);
}
if (!mongoUri) {
  console.error('✗ MONGODB_URI is unset in .env.local');
  process.exit(1);
}

const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });

// Minimal HostingPlan schema — matches the fields this script touches.
// `strict: false` so any other fields on existing docs are preserved on save.
const HostingPlanSchema = new mongoose.Schema(
  {
    planId: String,
    name: String,
    renewalPrice: Number,
    razorpayPlans: { monthly: String, yearly: String },
  },
  { strict: false, collection: 'hostingplans' }
);
const HostingPlan = mongoose.model('HostingPlan', HostingPlanSchema);

async function main() {
  console.log(`\n─── Razorpay LIVE Plan Regeneration ───`);
  console.log(`  Mode:    ${APPLY ? 'APPLY (will write to Razorpay + MongoDB)' : 'DRY-RUN (no writes)'}`);
  console.log(`  Key:     ${keyId}`);
  console.log(`  Backup:  ${BACKUP_FILE}`);
  console.log('');

  await mongoose.connect(mongoUri);
  console.log('✓ MongoDB connected');

  const plans = await HostingPlan.find({
    name: { $in: COMMERCIAL_TIER_NAMES },
  }).sort({ name: 1 });

  if (plans.length !== 3) {
    console.error(
      `\n✗ Expected 3 commercial-tier HostingPlan docs (${COMMERCIAL_TIER_NAMES.join(
        ' / '
      )}), found ${plans.length}.`
    );
    plans.forEach((p) =>
      console.error(
        `   - ${p.name}: planId=${p.planId} renewalPrice=${p.renewalPrice} razorpayPlans=${JSON.stringify(
          p.razorpayPlans
        )}`
      )
    );
    await mongoose.disconnect();
    process.exit(2);
  }

  console.log(`\n=== Current state (3 commercial tiers found) ===\n`);
  for (const p of plans) {
    const monthly = p.renewalPrice.toFixed(2);
    const yearly = (p.renewalPrice * 12).toFixed(2);
    console.log(`  ${p.name}:`);
    console.log(`    planId:        ${p.planId}`);
    console.log(`    renewalPrice:  ₹${monthly}/mo  (yearly ₹${yearly} = ${Math.round(p.renewalPrice * 12 * 100)} paise to Razorpay)`);
    console.log(`    razorpayPlans: monthly=${p.razorpayPlans?.monthly || '(not set)'}`);
    console.log(`                   yearly =${p.razorpayPlans?.yearly || '(not set)'}`);
    console.log('');
  }

  // ── Dry-run: print intended actions and exit ─────────────────────────────
  if (!APPLY) {
    console.log(`=== DRY-RUN — would do the following if run with --apply ===\n`);
    for (const p of plans) {
      const monthly = p.renewalPrice.toFixed(2);
      const yearly = (p.renewalPrice * 12).toFixed(2);
      console.log(`  ${p.name}:`);
      console.log(
        `    Razorpay.plans.create  name="${p.name} - Monthly"  desc="Renewal for ${p.name}"  amount=₹${monthly}  period=monthly`
      );
      console.log(
        `    Razorpay.plans.create  name="${p.name} - Yearly"   desc="Annual Renewal for ${p.name}"  amount=₹${yearly}  period=yearly`
      );
      console.log(`    HostingPlan.razorpayPlans = { monthly: <new_id>, yearly: <new_id> }`);
      console.log('');
    }
    console.log(`  Backup of the 3 current HostingPlan docs would be written to:`);
    console.log(`    ${BACKUP_FILE}\n`);
    console.log(`  Re-run with --apply to execute.\n`);
    await mongoose.disconnect();
    return;
  }

  // ── Apply: backup → create 6 live plans → write 3 DB updates ─────────────
  if (fs.existsSync(BACKUP_FILE)) {
    console.error(
      `\n✗ Backup file already exists at ${BACKUP_FILE} — refusing to overwrite.`
    );
    console.error(
      `  This usually means the script was already run successfully today.`
    );
    console.error(`  Delete or rename the file first if you intentionally want to re-run.\n`);
    await mongoose.disconnect();
    process.exit(3);
  }

  console.log(`=== APPLY MODE — writing live-mode plans ===\n`);
  fs.writeFileSync(BACKUP_FILE, JSON.stringify(plans.map((p) => p.toObject()), null, 2));
  console.log(`✓ Backup written: ${BACKUP_FILE}\n`);

  // Phase 1: create all 6 plans in Razorpay (in-memory result map)
  const newIds = {};
  for (const p of plans) {
    console.log(`  Creating Razorpay LIVE plans for ${p.name}...`);

    const monthly = await razorpay.plans.create({
      period: 'monthly',
      interval: 1,
      item: {
        name: `${p.name} - Monthly`,
        amount: Math.round(p.renewalPrice * 100),
        currency: 'INR',
        description: `Renewal for ${p.name}`,
      },
    });
    console.log(`    monthly → ${monthly.id}   (₹${p.renewalPrice}/mo)`);

    const yearly = await razorpay.plans.create({
      period: 'yearly',
      interval: 1,
      item: {
        name: `${p.name} - Yearly`,
        amount: Math.round(p.renewalPrice * 12 * 100),
        currency: 'INR',
        description: `Annual Renewal for ${p.name}`,
      },
    });
    console.log(`    yearly  → ${yearly.id}   (₹${p.renewalPrice * 12}/yr)`);

    newIds[p._id.toString()] = { monthly: monthly.id, yearly: yearly.id };
  }

  console.log(`\n✓ All 6 Razorpay LIVE plans created`);

  // Phase 2: update HostingPlan docs
  console.log(`\n  Writing new IDs to HostingPlan docs...`);
  for (const p of plans) {
    const ids = newIds[p._id.toString()];
    p.razorpayPlans = ids;
    await p.save();
    console.log(`    ${p.name}: razorpayPlans = { monthly: ${ids.monthly}, yearly: ${ids.yearly} }`);
  }

  console.log(`\n✓ All 3 HostingPlan docs updated.`);
  console.log(`\n=== Step 3 complete ===`);
  console.log(`  Verification:`);
  console.log(`    - Razorpay LIVE dashboard → Subscriptions → Plans → confirm 6 plans visible`);
  console.log(`    - Backup of pre-cutover state: ${BACKUP_FILE}`);
  console.log('');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('\n✗ ERROR:', err.message || err);
  if (err.stack) console.error(err.stack);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(99);
});
