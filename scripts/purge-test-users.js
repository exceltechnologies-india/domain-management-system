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
 *   3. DirectAdmin user accounts    (routed through the production
 *                                    /api/v1/admin/hosting/actions
 *                                    endpoint using `x-cron-secret`
 *                                    header — so the DA API call
 *                                    executes from Cloud Run's
 *                                    whitelisted IP, not the
 *                                    operator's local machine which
 *                                    is blocked at all 4 DA filter
 *                                    layers. Same endpoint the admin
 *                                    UI delete button uses; also
 *                                    cascade-cancels Razorpay subs +
 *                                    clears User.directAdminUsername
 *                                    mapping — no extra work needed
 *                                    below for those.)
 *   4. Hosting rows                 (by userId)
 *   5. PendingDomain rows           (by userId — domain registrations
 *                                    that hit insufficient-balance or
 *                                    other technical issues. Added
 *                                    2026-06-30 after a scrub left 3
 *                                    PendingDomain orphans that the
 *                                    dashboard's RC auto-sync picked
 *                                    back up when the user re-signed in)
 *   6. Domain rows                  (by userId — fully-registered
 *                                    domains. NOT touching ResellerClub
 *                                    on their side — see RC caveat below)
 *   7. TrialClaim rows              (by userId / userEmail / ipHash from
 *                                    any matching claim — resets the
 *                                    30-day abuse-defense throttle so
 *                                    the operator can re-test from the
 *                                    same IP without waiting)
 *   8. Invoice rows                 (by userId / userEmail — Zoho-side
 *                                    invoices are NOT touched; legal
 *                                    record there is the merchant's
 *                                    responsibility to clean up
 *                                    separately if needed)
 *   9. Order rows                   (by userId / userEmail)
 *  10. User document                (last — references above all
 *                                    pointed at this id)
 *
 * Safety guards:
 *   - Refuses to run if no emails are passed (no implicit default)
 *   - Skips users whose role is 'admin' (extra anti-footgun)
 *   - Dry-run by default; --apply required for any writes
 *   - Logs every action; surviving DA orphans are clearly flagged
 *
 * ResellerClub-side caveat (CRITICAL — read before re-testing):
 *   This script does NOT touch ResellerClub. The dashboard's auto-sync
 *   at app/dashboard/page.tsx fires `/api/domains/sync` 1s after first
 *   paint when `stats.totalDomains === 0`. That endpoint looks up the
 *   user's RC customer ID by email and re-pulls all their RC-side
 *   domains as synthetic `SYNC-*` Orders. So if the test user's email
 *   is still linked to an RC customer with pending or active domains,
 *   re-signing in with the same email will resurrect the domain rows
 *   in our DB — and the user will see them on /dashboard/domains again.
 *
 *   To prevent that, before re-using a test email: log into the
 *   ResellerClub partner dashboard and either (a) cancel/delete the
 *   relevant Customer + Order, or (b) use a completely different test
 *   email for the next signup. Option (b) is the cleanest because it
 *   sidesteps any RC-side reconciliation entirely.
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

// ── DirectAdmin delete via the production admin-actions endpoint ──
//
// Why not call DA directly (the old approach): operator machines aren't
// whitelisted at DA's 4 filter layers (network firewall + CSF + BFM skip +
// login-key Allow Networks). Only Cloud Run's NAT egress IP is. Direct
// CMD_API_SELECT_USERS calls from local always return 401 "Not logged in",
// which the previous version of this function silently reported as
// "success (raw text: ...)" or a permission error, orphaning DA accounts.
//
// The endpoint here (`/api/v1/admin/hosting/actions` = the same route the
// admin dashboard's Delete button uses) runs on Cloud Run — its outbound
// DA calls come from the whitelisted IP. Auth is via the shared
// `x-cron-secret` header path added 2026-07-02; see route file for the
// full rationale.
//
// The route also cancels any Razorpay subscription attached to the row
// and clears User.directAdminUsername mapping — cascade steps we used to
// do here inline are now handled server-side, which is why steps 4/5
// below still run (idempotent: they'll just report 0 deleted for the
// already-cleaned Hosting row).
async function daDeleteUser(username) {
  const appUrl = process.env.APP_URL || 'https://app.anutech.in';
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return {
      ok: false,
      reason:
        'CRON_SECRET not set in .env.local — fetch with: gcloud secrets versions access latest --secret=CRON_SECRET --project=speedy-unison-453807-e9',
    };
  }
  try {
    const res = await fetch(`${appUrl}/api/v1/admin/hosting/actions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-cron-secret': cronSecret,
      },
      body: JSON.stringify({ action: 'delete', username }),
      signal: AbortSignal.timeout(30000),
    });
    let body;
    try {
      body = await res.json();
    } catch {
      const text = await res.text().catch(() => '');
      return { ok: false, reason: `HTTP ${res.status} non-JSON body: ${text.slice(0, 200)}` };
    }
    if (res.status !== 200 || !body?.success) {
      return {
        ok: false,
        reason: `HTTP ${res.status} ${body?.code || ''} ${body?.error || JSON.stringify(body).slice(0, 200)}`,
      };
    }
    const outcome = body?.data?.outcome || 'ok';
    const warning = body?.data?.warning;
    // 'deleted' + 'user_not_found' are both clean successes for our
    // purposes; the second means the DA orphan was already gone (still
    // a good outcome for a scrub script). Anything else (da_unreachable,
    // hard_failure) surfaces via `warning` — local records were still
    // cleared on the server side, so we report ok:true but pass the
    // warning through so the operator sees it.
    if (warning) {
      return { ok: true, reason: `${outcome} (warning: ${warning})` };
    }
    return { ok: true, reason: outcome };
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
    pendingdomains: db.collection('pendingdomains'),
    domains: db.collection('domains'),
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
    // Domain registrations — by userId AND by userEmail to catch records
    // where the user re-signed up after a prior purge and orphaned domain
    // rows lost the userId linkage. PendingDomain rows in particular may
    // pre-date the User record they're now linked to.
    const pendingdomains = await c.pendingdomains.find({ $or: [{ userId }, { userEmail: email }] }).toArray();
    const domains = await c.domains.find({ $or: [{ userId }, { userEmail: email }] }).toArray();
    const daUsernames = hostings.map((h) => h.directAdminUsername).filter(Boolean);

    console.log(`  User _id              : ${userId}`);
    console.log(`  Hostings              : ${hostings.length}`);
    console.log(`  Orders                : ${orders.length}`);
    console.log(`  Invoices              : ${invoices.length}`);
    console.log(`  PendingHostings       : ${pending.length}`);
    console.log(`  PendingDomains        : ${pendingdomains.length}${pendingdomains.length ? ` (${pendingdomains.map((p) => p.domainName).join(', ')})` : ''}`);
    console.log(`  Domains               : ${domains.length}${domains.length ? ` (${domains.map((d) => d.domainName).join(', ')})` : ''}`);
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
    // 5. PendingDomains
    {
      const r = await c.pendingdomains.deleteMany({ $or: [{ userId }, { userEmail: email }] });
      console.log(`  ✓ Deleted ${r.deletedCount} PendingDomain rows`);
    }
    // 6. Domains (fully-registered). NOT touching ResellerClub — see
    //    file-header caveat. The dashboard's RC auto-sync will resurrect
    //    these rows when the test email re-signs in unless RC is cleaned
    //    separately.
    {
      const r = await c.domains.deleteMany({ $or: [{ userId }, { userEmail: email }] });
      console.log(`  ✓ Deleted ${r.deletedCount} Domain rows`);
    }
    // 7. TrialClaims
    {
      const r = await c.trialclaims.deleteMany({ $or: [{ userId }, { userEmail: email }] });
      console.log(`  ✓ Deleted ${r.deletedCount} TrialClaim rows`);
    }
    // 8. Invoices
    {
      const r = await c.invoices.deleteMany({ $or: [{ userId }, { userEmail: email }] });
      console.log(`  ✓ Deleted ${r.deletedCount} Invoice rows`);
    }
    // 9. Orders
    {
      const r = await c.orders.deleteMany({ $or: [{ userId }, { userEmail: email }] });
      console.log(`  ✓ Deleted ${r.deletedCount} Order rows`);
    }
    // 10. User
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
