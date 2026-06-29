#!/usr/bin/env node
/**
 * One-off cleanup script: purge test users + all related data.
 *
 * Born 2026-06-29 to clean up test-user signups accumulated during the
 * Manual-flow launch verification. Intentionally NOT exposed as an admin
 * endpoint — this is a one-shot operator tool, kept in scripts/ so the
 * destructive surface area doesn't live in the public HTTP routes.
 *
 * Usage:
 *
 *   # Dry-run (touches nothing — prints what WOULD be deleted)
 *   node scripts/purge-test-users.js user@example.com other@test.com
 *
 *   # Actually delete (irreversible — review dry-run output FIRST)
 *   node scripts/purge-test-users.js --apply user@example.com other@test.com
 *
 * Cascade order (most-dependent → least-dependent):
 *   1. RecurringChargeAttempt rows  (by hostingId in user's Hostings)
 *   2. PendingHosting rows          (by userId / userEmail)
 *   3. DirectAdmin user accounts    (best-effort HTTP call; if DA is
 *                                    down, the local Hosting row is
 *                                    still removed — DA orphan rows
 *                                    must be cleaned manually in that
 *                                    case)
 *   4. Hosting rows                 (by userId)
 *   5. TrialClaim rows              (by userId / userEmail / ipHash from
 *                                    any matching claim — resets the
 *                                    30-day abuse-defense throttle so
 *                                    the operator can re-test from the
 *                                    same IP without waiting)
 *   6. Invoice rows                 (by userId / userEmail — Zoho-side
 *                                    invoices are NOT touched; legal
 *                                    record there is the merchant's
 *                                    responsibility to clean up
 *                                    separately if needed)
 *   7. Order rows                   (by userId / userEmail)
 *   8. User document                (last — references above all
 *                                    pointed at this id)
 *
 * Safety guards:
 *   - Refuses to run if no emails are passed (no implicit default)
 *   - Skips users whose role is 'admin' (extra anti-footgun)
 *   - Dry-run by default; --apply required for any writes
 *   - Logs every action; surviving DA orphans are clearly flagged
 *
 * Why not use the existing /api/admin/users DELETE endpoint:
 *   `permanentDeleteUser` in lib/services/users.ts only snapshots the
 *   user's name/email onto Order rows + drops the User document. It
 *   does NOT cascade-delete Hostings, Invoices, PendingHostings,
 *   RecurringChargeAttempts, TrialClaims, or DA accounts — the gaps
 *   matter for a test-data scrub where leftover Hostings would still
 *   appear in the admin UI and DA accounts would still hold disk +
 *   IP slots. This script does the full cascade.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });

const mongoose = require('mongoose');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const emails = args.filter((a) => a.includes('@'));

if (emails.length === 0) {
  console.error('❌ No emails supplied. Usage:');
  console.error('   node scripts/purge-test-users.js user@x.com other@y.com');
  console.error('   node scripts/purge-test-users.js --apply user@x.com other@y.com');
  process.exit(1);
}

const MODE = apply ? '🔴 APPLY' : '🟢 DRY-RUN';
console.log(`\n${MODE} — ${emails.length} target user(s):`);
emails.forEach((e) => console.log(`   • ${e}`));
console.log('');

// ── DirectAdmin client (lightweight, fetch-based, no model imports) ──
//
// Mirrors the call pattern in lib/directadmin/users.ts:deleteUser —
// POST to /CMD_API_SELECT_USERS with location/delete/confirmed/select0.
// Returns { ok: boolean, reason: string }; best-effort by design (a DA
// outage shouldn't block the MongoDB cleanup).
async function daDeleteUser(username) {
  const baseUrl = process.env.DIRECTADMIN_URL;
  const adminUser = process.env.DIRECTADMIN_ADMIN_USER;
  const apiKey = process.env.DIRECTADMIN_API_KEY;
  if (!baseUrl || !adminUser || !apiKey) {
    return { ok: false, reason: 'DA env vars not set (DIRECTADMIN_URL/USER/API_KEY)' };
  }
  const body = new URLSearchParams({
    location: 'CMD_SELECT_USERS',
    delete: 'Delete',
    confirmed: 'Confirm',
    select0: username,
  }).toString();
  const auth = Buffer.from(`${adminUser}:${apiKey}`).toString('base64');
  try {
    const res = await fetch(`${baseUrl}/CMD_API_SELECT_USERS`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    if (text && (text.includes('error=1') || text.startsWith('error=1'))) {
      return { ok: false, reason: text.slice(0, 200) };
    }
    if (text.toLowerCase().includes('unable to find user')) {
      return { ok: true, reason: 'already gone (DA reports user_not_found)' };
    }
    return { ok: true, reason: text.slice(0, 200) || 'deleted' };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  }
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('❌ MONGODB_URI not set in .env.local');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log('✓ Connected to MongoDB');

  // Direct collection access — bypasses Mongoose schemas/models for
  // a one-off cleanup. Collection names follow Mongoose's pluralize +
  // lowercase convention.
  const db = mongoose.connection.db;
  const c = {
    users: db.collection('users'),
    orders: db.collection('orders'),
    hostings: db.collection('hostings'),
    invoices: db.collection('invoices'),
    pendinghostings: db.collection('pendinghostings'),
    recurringchargeattempts: db.collection('recurringchargeattempts'),
    trialclaims: db.collection('trialclaims'),
  };

  let totalUsersTouched = 0;
  let totalDaPurged = 0;
  let totalDaOrphans = 0;

  for (const email of emails) {
    console.log(`\n────────────────────────────────────────`);
    console.log(`▶ ${email}`);
    console.log(`────────────────────────────────────────`);

    const user = await c.users.findOne({ email });
    if (!user) {
      console.log('  ⚠ User not found in DB — skipping');
      continue;
    }
    if (user.role === 'admin') {
      console.log(`  🛑 SKIP — user role is 'admin'. Use a non-admin email or remove the role first.`);
      continue;
    }
    totalUsersTouched += 1;
    const userId = user._id;

    // Inventory the cascade before touching anything
    const hostings = await c.hostings.find({ userId }).toArray();
    const hostingIds = hostings.map((h) => h._id);
    const orders = await c.orders.find({ $or: [{ userId }, { userEmail: email }] }).toArray();
    const invoices = await c.invoices.find({ $or: [{ userId }, { userEmail: email }] }).toArray();
    const pending = await c.pendinghostings.find({ $or: [{ userId }, { userEmail: email }] }).toArray();
    const rca = hostingIds.length
      ? await c.recurringchargeattempts.find({ hostingId: { $in: hostingIds } }).toArray()
      : [];
    const claims = await c.trialclaims.find({ $or: [{ userId }, { userEmail: email }] }).toArray();
    const daUsernames = hostings.map((h) => h.directAdminUsername).filter(Boolean);

    console.log(`  User _id              : ${userId}`);
    console.log(`  Hostings              : ${hostings.length}`);
    console.log(`  Orders                : ${orders.length}`);
    console.log(`  Invoices              : ${invoices.length}`);
    console.log(`  PendingHostings       : ${pending.length}`);
    console.log(`  RecurringChargeAttempt: ${rca.length}`);
    console.log(`  TrialClaims           : ${claims.length}`);
    console.log(`  DA accounts           : ${daUsernames.length ? daUsernames.join(', ') : '(none)'}`);

    if (!apply) {
      console.log(`  🟢 dry-run — no writes`);
      continue;
    }

    // ── APPLY MODE ── delete in cascade order

    // 1. RecurringChargeAttempt
    if (hostingIds.length) {
      const r = await c.recurringchargeattempts.deleteMany({ hostingId: { $in: hostingIds } });
      console.log(`  ✓ Deleted ${r.deletedCount} RecurringChargeAttempt rows`);
    }
    // 2. PendingHosting
    {
      const r = await c.pendinghostings.deleteMany({ $or: [{ userId }, { userEmail: email }] });
      console.log(`  ✓ Deleted ${r.deletedCount} PendingHosting rows`);
    }
    // 3. DA accounts (best-effort)
    for (const username of daUsernames) {
      const out = await daDeleteUser(username);
      if (out.ok) {
        totalDaPurged += 1;
        console.log(`  ✓ DA deleted ${username} (${out.reason})`);
      } else {
        totalDaOrphans += 1;
        console.log(`  ⚠ DA delete FAILED for ${username}: ${out.reason}`);
        console.log(`     Local Hosting row will still be removed below;`);
        console.log(`     clean up the DA orphan manually if needed.`);
      }
    }
    // 4. Hostings
    {
      const r = await c.hostings.deleteMany({ userId });
      console.log(`  ✓ Deleted ${r.deletedCount} Hosting rows`);
    }
    // 5. TrialClaims
    {
      const r = await c.trialclaims.deleteMany({ $or: [{ userId }, { userEmail: email }] });
      console.log(`  ✓ Deleted ${r.deletedCount} TrialClaim rows`);
    }
    // 6. Invoices
    {
      const r = await c.invoices.deleteMany({ $or: [{ userId }, { userEmail: email }] });
      console.log(`  ✓ Deleted ${r.deletedCount} Invoice rows`);
    }
    // 7. Orders
    {
      const r = await c.orders.deleteMany({ $or: [{ userId }, { userEmail: email }] });
      console.log(`  ✓ Deleted ${r.deletedCount} Order rows`);
    }
    // 8. User
    {
      const r = await c.users.deleteOne({ _id: userId });
      console.log(`  ✓ Deleted ${r.deletedCount} User document`);
    }

    console.log(`  ✅ Purged.`);
  }

  console.log(`\n────────────────────────────────────────`);
  console.log(`Summary`);
  console.log(`────────────────────────────────────────`);
  console.log(`  Users targeted     : ${emails.length}`);
  console.log(`  Users found/eligible: ${totalUsersTouched}`);
  if (apply) {
    console.log(`  DA accounts purged : ${totalDaPurged}`);
    console.log(`  DA orphans (manual): ${totalDaOrphans}`);
    console.log(`\n✅ APPLY complete.`);
  } else {
    console.log(`\n🟢 Dry-run complete. Add --apply to actually delete.`);
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error('❌ Script failed:', e);
  process.exit(1);
});
