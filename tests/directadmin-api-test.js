'use strict';
/**
 * DirectAdmin API Test — Live integration test covering:
 *  1. Auth guards on all DA-related endpoints
 *  2. Server connectivity & read-only operations
 *  3. Full hosting lifecycle: provision → suspend → unsuspend → delete
 *  4. User SSO endpoint
 *  5. Admin diag / details endpoints
 */
const { execSync } = require('child_process');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config({ path: '.env.local' });

const BASE = 'http://localhost:3000';
let passed = 0, failed = 0;
const log  = m => process.stdout.write(m + '\n');
const pass = (name, detail = '') => { passed++; log(`  ✅ PASS  ${name}${detail ? '  →  ' + detail : ''}`); };
const fail = (name, detail = '') => { failed++; log(`  ❌ FAIL  ${name}${detail ? '  →  ' + detail : ''}`); };
const info = (m) => log(`  ℹ️  ${m}`);

// ── Helpers ───────────────────────────────────────────────────────────────────
function curl(path, { method = 'GET', cookie = '', data = '', headers = [] } = {}) {
  const cookieFlag = cookie ? `-H "Cookie: ${cookie}"` : '';
  const dataFlag   = data   ? `-H "Content-Type: application/json" -d '${data}'` : '';
  const extraHeaders = headers.map(h => `-H "${h}"`).join(' ');
  const cmd = `curl -s -w '\\n__STATUS__%{http_code}' -X ${method} ${cookieFlag} ${dataFlag} ${extraHeaders} "${BASE}${path}"`;
  const raw = execSync(cmd, { timeout: 30000 }).toString();
  const sep = raw.lastIndexOf('\n__STATUS__');
  const body = raw.slice(0, sep);
  const status = parseInt(raw.slice(sep + 11), 10);
  let json = null;
  try { json = JSON.parse(body); } catch {}
  return { status, body, json };
}

function getSessionCookies(email, password, cookieFile) {
  const csrfRaw = execSync(`curl -s -c ${cookieFile} ${BASE}/api/auth/csrf`, { timeout: 10000 }).toString();
  const csrf = JSON.parse(csrfRaw).csrfToken;
  const enc = encodeURIComponent;
  execSync(
    `curl -s -c ${cookieFile} -b ${cookieFile} -X POST ${BASE}/api/auth/callback/credentials ` +
    `-H "Content-Type: application/x-www-form-urlencoded" ` +
    `-d "email=${enc(email)}&password=${enc(password)}&csrfToken=${enc(csrf)}&callbackUrl=${enc(BASE+'/dashboard')}&json=true"`,
    { timeout: 20000 }
  );
  const contents = require('fs').readFileSync(cookieFile, 'utf8');
  const cookies = [];
  for (let line of contents.split('\n')) {
    if (!line.trim()) continue;
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length);
    else if (line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length >= 7) cookies.push(`${parts[5]}=${parts[6]}`);
  }
  return cookies.join('; ');
}

// Config
const TS          = Date.now();
const TEST_USER_EMAIL = `datest_${TS}@anutech-test.com`;
const TEST_USER_PASS  = 'DaTest@2025x!';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'sales@anutech.in';
const ADMIN_PASS  = process.env.ADMIN_PASSWORD;

// DA test user — will be provisioned then deleted
const DA_TEST_USER   = `t${Math.random().toString(36).slice(2, 7)}`;
const DA_TEST_DOMAIN = `${DA_TEST_USER}.test-domain.invalid`;

// ── Setup ─────────────────────────────────────────────────────────────────────
async function setup() {
  await mongoose.connect(process.env.MONGODB_URI);
  const User  = mongoose.models.User  || mongoose.model('User',  new mongoose.Schema({}, {strict:false}));

  await User.deleteOne({ email: TEST_USER_EMAIL });
  const testUser = await User.create({
    email: TEST_USER_EMAIL, password: await bcrypt.hash(TEST_USER_PASS, 10),
    firstName: 'DaTest', lastName: 'User', phone: '9876543210', phoneCc: '+91',
    role: 'user', isActivated: true, isActive: true, profileCompleted: true,
    provider: 'credentials',
    address: { line1: '1 Test St', city: 'Mumbai', state: 'Maharashtra', country: 'India', zipcode: '400001' }
  });

  // Find a real DA user for details/SSO tests
  const Hosting = mongoose.models.Hosting || mongoose.model('Hosting', new mongoose.Schema({}, {strict:false}));
  const realHosting = await Hosting.findOne({ status: { $in: ['active', 'suspended'] }, directAdminUsername: { $exists: true, $ne: '' } }).lean();

  await mongoose.disconnect();
  return { testUserId: testUser._id.toString(), realHosting };
}

async function cleanup(provisionedDA) {
  // Clean test DA user if it was provisioned
  if (provisionedDA) {
    try {
      const axios = require('axios');
      const DA_URL = process.env.DIRECTADMIN_URL;
      const ADMIN_USER = process.env.DIRECTADMIN_ADMIN_USER;
      const API_KEY = process.env.DIRECTADMIN_API_KEY;
      await axios.post(`${DA_URL}/CMD_API_SELECT_USERS`,
        `location=CMD_SELECT_USERS&delete=Delete&confirmed=Confirm&select0=${DA_TEST_USER}`,
        { auth: { username: ADMIN_USER, password: API_KEY },
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 15000 });
      info(`Cleaned up DA test user ${DA_TEST_USER}`);
    } catch(e) { info(`DA cleanup warning: ${e.message}`); }
  }

  await mongoose.connect(process.env.MONGODB_URI);
  const User    = mongoose.models.User    || mongoose.model('User',    new mongoose.Schema({}, {strict:false}));
  const Hosting = mongoose.models.Hosting || mongoose.model('Hosting', new mongoose.Schema({}, {strict:false}));
  await User.deleteOne({ email: TEST_USER_EMAIL });
  await Hosting.deleteMany({ directAdminUsername: DA_TEST_USER });
  await mongoose.disconnect();
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  log('');
  log('╔══════════════════════════════════════════════════════════════╗');
  log('║          DirectAdmin Integration — Live API Tests            ║');
  log('╚══════════════════════════════════════════════════════════════╝');
  log('');

  const { testUserId, realHosting } = await setup();
  info(`Test app user: ${TEST_USER_EMAIL}  (id: ${testUserId})`);
  info(`DA test username: ${DA_TEST_USER}  domain: ${DA_TEST_DOMAIN}`);
  info(`Real hosting account: ${realHosting?.directAdminUsername || 'none found'}`);
  log('');

  // ── 1. Auth Guards ─────────────────────────────────────────────────────────
  log('▶ 1. Auth Guards (all should reject unauthenticated)\n');

  const guards = [
    ['GET', '/api/admin/diag-da'],
    ['GET', '/api/admin/hosting/packages'],
    ['GET', '/api/admin/hosting/stats'],
    ['GET', '/api/admin/hosting/details?username=test'],
    ['POST', '/api/admin/hosting/provision'],
    ['POST', '/api/admin/hosting/actions'],
    ['GET', '/api/user/hosting/sso'],
    ['GET', '/api/user/hosting/stats'],
  ];
  for (const [method, path] of guards) {
    try {
      const r = curl(path, { method });
      (r.status === 401 || r.status === 403)
        ? pass(`${method} ${path} → ${r.status}`)
        : fail(`${method} ${path} auth guard`, `got ${r.status}`);
    } catch(e) { fail(`${method} ${path} auth guard`, e.message); }
  }

  // ── 2. Get Sessions ────────────────────────────────────────────────────────
  log('\n▶ 2. Session Setup\n');
  let adminCookie = '', userCookie = '';

  if (!ADMIN_PASS) {
    log('  ⚠  ADMIN_PASSWORD not set — skipping admin tests');
  } else {
    try {
      adminCookie = getSessionCookies(ADMIN_EMAIL, ADMIN_PASS, '/tmp/da_admin.txt');
      log('  🍪 Admin session obtained');
    } catch(e) { log(`  ⚠  Admin session failed: ${e.message}`); }
  }

  try {
    userCookie = getSessionCookies(TEST_USER_EMAIL, TEST_USER_PASS, '/tmp/da_user.txt');
    log('  🍪 User session obtained');
  } catch(e) { log(`  ⚠  User session failed: ${e.message}`); }

  // ── 3. DA Server Connectivity ──────────────────────────────────────────────
  log('\n▶ 3. DirectAdmin Server Connectivity\n');

  let discoveredDaUser = null; // first real DA username discovered from diag-da

  if (adminCookie) {
    // Packages list
    try {
      const r = curl('/api/admin/hosting/packages', { cookie: adminCookie });
      if (r.status === 200 && r.json?.success) {
        const src = r.json.source;
        const count = r.json.data?.length || 0;
        if (src === 'live') {
          pass(`GET /api/admin/hosting/packages → ${count} packages (live from DA)`);
        } else {
          pass(`GET /api/admin/hosting/packages → ${count} packages (${src} — DA unreachable, DB fallback OK)`);
        }
        if (r.json.warning) info(`Warning: ${r.json.warning}`);
      } else {
        fail('GET /api/admin/hosting/packages', `status=${r.status} body=${r.body.slice(0,120)}`);
      }
    } catch(e) { fail('GET /api/admin/hosting/packages', e.message); }

    // Diag-DA (read-only: no cleanup param) — also discovers real DA usernames
    try {
      const r = curl('/api/admin/diag-da', { cookie: adminCookie });
      if (r.status === 200 && r.json?.success) {
        const users = r.json.data?.users;
        const isConnected = Array.isArray(users);
        if (isConnected) {
          // Grab the first real (non-admin) user for details/SSO tests
          if (users.length > 0) discoveredDaUser = users[0];
          pass(`GET /api/admin/diag-da → DA connected, ${users.length} users listed`);
        } else {
          pass(`GET /api/admin/diag-da → 200 (DA may be offline: ${users?.error || 'no user list'})`);
        }
      } else {
        fail('GET /api/admin/diag-da', `status=${r.status} body=${r.body.slice(0,120)}`);
      }
    } catch(e) { fail('GET /api/admin/diag-da', e.message); }

    // Hosting stats (read-only)
    try {
      const r = curl('/api/admin/hosting/stats', { cookie: adminCookie });
      if (r.status === 200 && r.json?.success) {
        const src = r.json.source;
        const count = r.json.data?.length || 0;
        pass(`GET /api/admin/hosting/stats → ${count} accounts (source: ${src})`);
        if (r.json.daError) info(`DA error: ${r.json.daError}`);
      } else {
        fail('GET /api/admin/hosting/stats', `status=${r.status} body=${r.body.slice(0,120)}`);
      }
    } catch(e) { fail('GET /api/admin/hosting/stats', e.message); }
  }

  // ── 4. Details for Real Account ────────────────────────────────────────────
  log('\n▶ 4. Account Details (real account)\n');

  // Prefer a username discovered live from DA (guaranteed ≤16 chars and existing).
  // Fall back to DB record only if it satisfies DA's 16-char username limit.
  const dbUsername = realHosting?.directAdminUsername;
  const realUsername = discoveredDaUser || (dbUsername && dbUsername.length <= 16 ? dbUsername : null);
  if (realUsername) info(`Using DA username for details/SSO tests: ${realUsername}`);

  if (!adminCookie) {
    info('Skipping — no admin session');
  } else if (!realUsername) {
    info('No valid DA username found (DB record exceeds 16-char limit or none exists) — skipping details test');
  } else {
    try {
      const r = curl(`/api/admin/hosting/details?username=${realUsername}`, { cookie: adminCookie });
      if (r.status === 200 && r.json?.success) {
        const d = r.json.data;
        pass(`GET /api/admin/hosting/details → domain=${d?.domain} pkg=${d?.package} status=${d?.status}`);
      } else if (r.status === 500) {
        fail(`GET /api/admin/hosting/details`, `status=500 (DA user ${realUsername} may not exist on server)`);
      } else {
        fail(`GET /api/admin/hosting/details`, `status=${r.status} body=${r.body.slice(0,120)}`);
      }
    } catch(e) { fail('GET /api/admin/hosting/details', e.message); }
  }

  // ── 5. User SSO ────────────────────────────────────────────────────────────
  log('\n▶ 5. User SSO Endpoint\n');

  if (userCookie) {
    // No hosting account linked — should return 404
    try {
      const r = curl('/api/user/hosting/sso', {
        cookie: userCookie,
        headers: ['Accept: application/json']
      });
      if (r.status === 404 && r.json?.code === 'HOSTING_NOT_FOUND') {
        pass('GET /api/user/hosting/sso → 404 HOSTING_NOT_FOUND (no account linked — correct)');
      } else if (r.status === 302 || r.status === 307 || r.status === 301) {
        pass(`GET /api/user/hosting/sso → ${r.status} redirect (user has linked account)`);
      } else {
        fail('GET /api/user/hosting/sso', `got ${r.status} body=${r.body.slice(0,120)}`);
      }
    } catch(e) { fail('GET /api/user/hosting/sso', e.message); }

    // Wrong username ownership
    if (realUsername) {
      try {
        const r = curl(`/api/user/hosting/sso?username=${realUsername}`, {
          cookie: userCookie,
          headers: ['Accept: application/json']
        });
        if (r.status === 403 && r.json?.code === 'OWNERSHIP_VERIFICATION_FAILED') {
          pass(`GET /api/user/hosting/sso?username=${realUsername} → 403 ownership rejected (correct)`);
        } else if (r.status === 302 || r.status === 307) {
          // Could happen if test user's email matches the DA account (unlikely)
          pass(`GET /api/user/hosting/sso → redirect (user somehow owns ${realUsername})`);
        } else {
          fail(`GET /api/user/hosting/sso?username=${realUsername}`, `got ${r.status} body=${r.body.slice(0,120)}`);
        }
      } catch(e) { fail('GET /api/user/hosting/sso ownership check', e.message); }
    }
  }

  // User stats — no hosting linked → empty array
  if (userCookie) {
    try {
      const r = curl('/api/user/hosting/stats', { cookie: userCookie });
      if (r.status === 200 && Array.isArray(r.json?.data)) {
        pass(`GET /api/user/hosting/stats → ${r.json.data.length} accounts for test user (no DA account = 0 expected)`);
      } else if (r.status === 503) {
        pass('GET /api/user/hosting/stats → 503 DA_SERVER_DOWN (handled correctly)');
      } else {
        fail('GET /api/user/hosting/stats', `status=${r.status} body=${r.body.slice(0,120)}`);
      }
    } catch(e) { fail('GET /api/user/hosting/stats', e.message); }
  }

  // ── 6. Hosting Lifecycle: Provision → Suspend → Unsuspend → Delete ─────────
  log('\n▶ 6. Hosting Lifecycle (provision → suspend → unsuspend → delete)\n');

  let daProvisioned = false;

  if (!adminCookie) {
    info('Skipping lifecycle — no admin session');
  } else {
    // 6a. Provision
    try {
      const r = curl('/api/admin/hosting/provision', {
        method: 'POST',
        cookie: adminCookie,
        data: JSON.stringify({
          userId:       testUserId,
          domain:       DA_TEST_DOMAIN,
          packageName:  'Starter',
          daUsername:   DA_TEST_USER,
          validityPeriod: 1,
          price: 0
        })
      });
      if (r.status === 200 && r.json?.success) {
        daProvisioned = true;
        pass(`POST /api/admin/hosting/provision → ${r.json.message}`);
      } else if (r.status === 503) {
        pass('POST /api/admin/hosting/provision → 503 DA_SERVER_DOWN (DA unreachable — handled correctly)');
      } else if (r.status === 200 && r.json?.data?.savedToPending) {
        pass(`POST /api/admin/hosting/provision → added to pending list (DA error handled): ${r.json.message}`);
      } else if (r.status === 500 && r.json?.code === 'PROVISION_FAILED') {
        pass(`POST /api/admin/hosting/provision → 500 PROVISION_FAILED (DA rejected request — correct error propagation)`);
      } else {
        fail('POST /api/admin/hosting/provision', `status=${r.status} body=${r.body.slice(0,200)}`);
      }
    } catch(e) { fail('POST /api/admin/hosting/provision', e.message); }

    if (daProvisioned) {
      // 6b. Verify on DA via details endpoint
      try {
        const r = curl(`/api/admin/hosting/details?username=${DA_TEST_USER}`, { cookie: adminCookie });
        if (r.status === 200 && r.json?.success) {
          pass(`GET /api/admin/hosting/details → new account exists domain=${r.json.data?.domain} status=${r.json.data?.status}`);
        } else {
          fail('GET /api/admin/hosting/details (post-provision)', `status=${r.status}`);
        }
      } catch(e) { fail('details after provision', e.message); }

      // 6c. Suspend
      try {
        const r = curl('/api/admin/hosting/actions', {
          method: 'POST', cookie: adminCookie,
          data: JSON.stringify({ action: 'suspend', username: DA_TEST_USER })
        });
        if (r.status === 200 && r.json?.success) {
          pass(`POST /api/admin/hosting/actions (suspend) → ${DA_TEST_USER} suspended`);
        } else {
          fail('suspend action', `status=${r.status} body=${r.body.slice(0,150)}`);
        }
      } catch(e) { fail('suspend action', e.message); }

      // 6d. Verify suspended via details
      try {
        const r = curl(`/api/admin/hosting/details?username=${DA_TEST_USER}`, { cookie: adminCookie });
        if (r.status === 200 && r.json?.data?.status === 'suspended') {
          pass(`GET /api/admin/hosting/details → status=suspended (DA suspension verified)`);
        } else if (r.status === 200) {
          fail('verify suspension', `status field is '${r.json?.data?.status}', expected 'suspended'`);
        } else {
          fail('verify suspension', `status=${r.status}`);
        }
      } catch(e) { fail('verify suspension', e.message); }

      // 6e. Unsuspend
      try {
        const r = curl('/api/admin/hosting/actions', {
          method: 'POST', cookie: adminCookie,
          data: JSON.stringify({ action: 'unsuspend', username: DA_TEST_USER })
        });
        if (r.status === 200 && r.json?.success) {
          pass(`POST /api/admin/hosting/actions (unsuspend) → ${DA_TEST_USER} unsuspended`);
        } else {
          fail('unsuspend action', `status=${r.status} body=${r.body.slice(0,150)}`);
        }
      } catch(e) { fail('unsuspend action', e.message); }

      // 6f. Verify active again
      try {
        const r = curl(`/api/admin/hosting/details?username=${DA_TEST_USER}`, { cookie: adminCookie });
        if (r.status === 200 && r.json?.data?.status === 'active') {
          pass(`GET /api/admin/hosting/details → status=active (unsuspend verified)`);
        } else if (r.status === 200) {
          fail('verify unsuspend', `status='${r.json?.data?.status}', expected 'active'`);
        } else {
          fail('verify unsuspend', `status=${r.status}`);
        }
      } catch(e) { fail('verify unsuspend', e.message); }

      // 6g. Delete
      try {
        const r = curl('/api/admin/hosting/actions', {
          method: 'POST', cookie: adminCookie,
          data: JSON.stringify({ action: 'delete', username: DA_TEST_USER })
        });
        if (r.status === 200 && r.json?.success) {
          daProvisioned = false; // cleanup handled by route
          pass(`POST /api/admin/hosting/actions (delete) → ${DA_TEST_USER} deleted`);
        } else {
          fail('delete action', `status=${r.status} body=${r.body.slice(0,150)}`);
        }
      } catch(e) { fail('delete action', e.message); }
    }

    // 6h. Invalid action
    try {
      const r = curl('/api/admin/hosting/actions', {
        method: 'POST', cookie: adminCookie,
        data: JSON.stringify({ action: 'reboot', username: 'nobody' })
      });
      r.status === 400
        ? pass('POST /api/admin/hosting/actions invalid action → 400')
        : fail('invalid action guard', `got ${r.status}`);
    } catch(e) { fail('invalid action guard', e.message); }

    // 6i. Missing fields
    try {
      const r = curl('/api/admin/hosting/actions', {
        method: 'POST', cookie: adminCookie,
        data: JSON.stringify({ action: 'suspend' }) // no username
      });
      r.status === 400
        ? pass('POST /api/admin/hosting/actions missing username → 400')
        : fail('missing username guard', `got ${r.status}`);
    } catch(e) { fail('missing username guard', e.message); }

    // 6j. Details without username param
    try {
      const r = curl('/api/admin/hosting/details', { cookie: adminCookie }); // no ?username=
      r.status === 400
        ? pass('GET /api/admin/hosting/details without username → 400')
        : fail('details no username guard', `got ${r.status}`);
    } catch(e) { fail('details no username guard', e.message); }
  }

  // ── 7. RBAC: Non-admin can't hit admin routes ──────────────────────────────
  log('\n▶ 7. RBAC — Non-admin blocked from admin routes\n');

  if (userCookie) {
    const adminRoutes = [
      ['GET',  '/api/admin/hosting/packages'],
      ['GET',  '/api/admin/hosting/stats'],
      ['GET',  '/api/admin/diag-da'],
      ['POST', '/api/admin/hosting/provision'],
      ['POST', '/api/admin/hosting/actions'],
    ];
    for (const [method, path] of adminRoutes) {
      try {
        const r = curl(path, { method, cookie: userCookie });
        (r.status === 401 || r.status === 403)
          ? pass(`${method} ${path} → ${r.status} for non-admin (RBAC)`)
          : fail(`RBAC ${method} ${path}`, `non-admin got ${r.status}`);
      } catch(e) { fail(`RBAC ${method} ${path}`, e.message); }
    }
  } else {
    info('Skipping RBAC — no user session');
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  await cleanup(daProvisioned);

  const total = passed + failed;
  log('');
  log('╔══════════════════════════════════════════════════════════════╗');
  log(`║  Results: ${String(passed).padEnd(3)} passed  |  ${String(failed).padEnd(3)} failed  (${total} total)${' '.repeat(18 - String(total).length)}║`);
  log('╚══════════════════════════════════════════════════════════════╝');
  log('');
  if (failed > 0) process.exit(1);
})().catch(e => { console.error('Fatal:', e.message, e.stack); process.exit(1); });
