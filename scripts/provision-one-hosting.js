#!/usr/bin/env node
/**
 * One-off DA-provisioner for a SINGLE pending Hosting record. Bypasses
 * the `findPendingTokensFlowHostings` finder's `razorpayTokenId` filter
 * so it works on manual-flow trials too (which have no razorpayTokenId).
 *
 * Why this exists: the existing cron at `provision-pending-tokens-hostings.js`
 * only picks up Tokens-flow trials (razorpayTokenId set) AND early-exits
 * when `HOSTING_MANDATE_FLOW !== 'tokens'`. Production is currently on
 * HOSTING_MANDATE_FLOW='manual', so manual-flow trials sit in
 * status='pending' forever unless someone provisions them. Full
 * flow-agnostic cron extension is planned (see TASKS.md "Gap B"); this
 * script is the operator's stopgap until that lands.
 *
 * The provisioning function itself (`provisionTokensFlowHosting`) is
 * 99% flow-agnostic — creates the DA user, flips Hosting.status='active',
 * mirrors directAdminUsername onto the User row, sends the welcome
 * email. Only the finder's filter is Tokens-specific. So we load the
 * Hosting doc directly by _id (or by domainName as a fallback) and
 * invoke the provisioner on it.
 *
 * Usage:
 *
 *   # By Hosting _id (preferred — unambiguous)
 *   node scripts/provision-one-hosting.js --id 6a45f1563ac5b522768b6483
 *
 *   # By domainName (matches the newest pending Hosting for the domain)
 *   node scripts/provision-one-hosting.js --domain testing.com
 *
 * Guards:
 *   - Refuses if no --id / --domain arg
 *   - Loads the Hosting by _id or domain lookup
 *   - Refuses if the Hosting already has a directAdminUsername
 *     (would double-provision + create an orphan)
 *   - Refuses if the Hosting.status !== 'pending' (nothing to do)
 *   - Logs the ProvisionResult from the provisioner so DA_unreachable /
 *     collision / hard_failure surface clearly
 *
 * NOT in scope:
 *   - Bulk provisioning (use the cron for that once the flow-agnostic
 *     extension ships)
 *   - Reprovisioning an already-active Hosting (destructive; would
 *     need a separate tool)
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });

const mongoose = require('mongoose');

const args = process.argv.slice(2);
const idIdx = args.indexOf('--id');
const domainIdx = args.indexOf('--domain');
const hostingIdArg = idIdx >= 0 ? args[idIdx + 1] : null;
const domainArg = domainIdx >= 0 ? args[domainIdx + 1] : null;

if (!hostingIdArg && !domainArg) {
  console.error('❌ Usage:');
  console.error('   node scripts/provision-one-hosting.js --id <hostingId>');
  console.error('   node scripts/provision-one-hosting.js --domain <domainName>');
  process.exit(1);
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('❌ MONGODB_URI not set in .env.local');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log('✓ Connected to MongoDB');

  // Import the Hosting model + provisioner. Dynamic imports because
  // the provisioner is a TS module that references other TS models.
  const Hosting = (await import('../models/Hosting.ts')).default;
  const { provisionTokensFlowHosting } = await import(
    '../lib/services/payment/tokens-da-provisioner.ts'
  );

  // Load the Hosting doc.
  let hosting;
  if (hostingIdArg) {
    if (!/^[0-9a-fA-F]{24}$/.test(hostingIdArg)) {
      console.error(`❌ --id must be a 24-hex-char ObjectId; got ${JSON.stringify(hostingIdArg)}`);
      await mongoose.disconnect();
      process.exit(1);
    }
    hosting = await Hosting.findById(hostingIdArg);
    if (!hosting) {
      console.error(`❌ No Hosting found with _id=${hostingIdArg}`);
      await mongoose.disconnect();
      process.exit(1);
    }
  } else {
    // Newest pending Hosting for this domain.
    hosting = await Hosting.findOne({
      domainName: domainArg.toLowerCase().trim(),
      status: 'pending',
    })
      .sort({ createdAt: -1 })
      .exec();
    if (!hosting) {
      console.error(`❌ No pending Hosting found for domain ${JSON.stringify(domainArg)}`);
      await mongoose.disconnect();
      process.exit(1);
    }
  }

  console.log('');
  console.log('Target Hosting:');
  console.log(`   _id                    : ${hosting._id}`);
  console.log(`   domainName             : ${hosting.domainName}`);
  console.log(`   userId                 : ${hosting.userId}`);
  console.log(`   status                 : ${hosting.status}`);
  console.log(`   billingType            : ${hosting.billingType}`);
  console.log(`   isTrial                : ${hosting.isTrial}`);
  console.log(`   directAdminUsername    : ${JSON.stringify(hosting.directAdminUsername)}`);
  console.log(`   razorpayTokenId        : ${hosting.razorpayTokenId ?? '(unset)'}`);
  console.log(`   planId / serverPackage : ${hosting.planId} / ${hosting.serverPackage}`);
  console.log('');

  // Pre-flight guards. The provisioner has an internal
  // already-provisioned guard too but we want the early-exit message
  // to be clear at the CLI level.
  if (hosting.directAdminUsername) {
    console.error(
      `🛑 Hosting already has directAdminUsername=${JSON.stringify(hosting.directAdminUsername)}. Refusing to double-provision.`
    );
    await mongoose.disconnect();
    process.exit(1);
  }
  if (hosting.status !== 'pending') {
    console.error(
      `🛑 Hosting.status is ${JSON.stringify(hosting.status)}, not 'pending'. Refusing to provision.`
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log('🔄 Invoking provisionTokensFlowHosting (flow-agnostic — bypasses razorpayTokenId filter)…');
  const result = await provisionTokensFlowHosting(hosting);

  console.log('');
  console.log('Result:');
  console.log(`   outcome     : ${result.outcome}`);
  if (result.daUsername) console.log(`   daUsername  : ${result.daUsername}`);
  if (result.reason) console.log(`   reason      : ${result.reason}`);
  console.log('');

  if (result.outcome === 'activated') {
    console.log(`✅ Provisioned — Hosting.status is now 'active' and welcome email dispatched.`);
  } else if (result.outcome === 'skipped') {
    console.log(`⏭️  Skipped (idempotency guard hit — probably a concurrent provision run).`);
  } else if (result.outcome === 'da_unreachable') {
    console.log(`⚠️  DA unreachable — Hosting.status stays 'pending'; re-run this script when DA is back.`);
  } else if (result.outcome === 'collision_exhausted') {
    console.log(`❌ Username collisions exhausted — investigate DA-side existing accounts for this domain.`);
  } else {
    console.log(`❌ Hard failure — see reason above + Cloud Run logs.`);
  }

  await mongoose.disconnect();
  process.exit(result.outcome === 'activated' || result.outcome === 'skipped' ? 0 : 1);
}

main().catch((e) => {
  console.error('❌ Script crashed:', e);
  process.exit(1);
});
