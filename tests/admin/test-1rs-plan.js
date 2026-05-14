#!/usr/bin/env node
/**
 * ₹1 Test Plan — End-to-End API Test
 *
 * Tests the full enable/disable cycle for the ₹1 live-payment test plan.
 * Uses direct API calls (not browser clicks) so CSRF origin header can be
 * set correctly to https://app.anutech.in.
 *
 * Tests:
 *  T1  Admin GET  → plan is disabled initially
 *  T2  Admin POST enable → plan enabled, Razorpay plan created / reused
 *  T3  Public GET → enabled=true, plan data returned
 *  T4  Admin GET  → enabled=true confirmed
 *  T5  Admin POST disable → plan disabled
 *  T6  Public GET → enabled=false confirmed
 *  T7  Admin GET  → enabled=false confirmed
 */

require('dotenv').config({ path: '.env.local' });
const https = require('https');
const { encode } = require('next-auth/jwt');

const NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET;
const ADMIN_USER_ID  = '68e5fd91602c8b9a2b12286d';
const BASE           = 'https://localhost';
const PRODUCTION_ORIGIN = 'https://app.anutech.in';

let pass = 0, fail = 0;
function PASS(name, detail = '') { console.log(`✅ PASS: ${name}${detail ? ' — ' + detail : ''}`); pass++; }
function FAIL(name, detail = '') { console.log(`❌ FAIL: ${name}${detail ? ' — ' + detail : ''}`); fail++; }

// Build a NextAuth session token cookie (same format the app reads via getToken())
async function makeAdminCookie() {
  const token = await encode({
    token: {
      id:    ADMIN_USER_ID,
      email: 'sales@exceltechnologies.in',
      role:  'admin',
      iat:   Math.floor(Date.now() / 1000),
      exp:   Math.floor(Date.now() / 1000) + 3600,
    },
    secret: NEXTAUTH_SECRET,
    maxAge: 3600,
  });
  // Use __Secure- prefix cookie (app runs on HTTPS)
  return `__Secure-next-auth.session-token=${token}`;
}

// Generic HTTPS request helper
function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'localhost',
      port: 443,
      path,
      method,
      rejectUnauthorized: false,
      headers: {
        'Content-Type': 'application/json',
        'Origin': PRODUCTION_ORIGIN,
        'Cookie': cookie || '',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const r = https.request(options, res => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function run() {
  console.log('── ₹1 Test Plan API tests ──\n');

  const cookie = await makeAdminCookie();

  // T1: Admin GET — should show disabled initially
  try {
    const { status, body } = await req('GET', '/api/admin/hosting/test-plan', null, cookie);
    if (status === 200) {
      PASS('T1: Admin GET returns 200', `enabled=${body.enabled}`);
    } else {
      FAIL('T1: Admin GET returns 200', `status=${status} body=${JSON.stringify(body)}`);
    }
  } catch (e) { FAIL('T1: Admin GET returns 200', e.message); }

  // T2: Admin POST enable
  let enabledOk = false;
  try {
    const { status, body } = await req('POST', '/api/admin/hosting/test-plan', { action: 'enable' }, cookie);
    if (status === 200 && body.enabled === true) {
      PASS('T2: Admin POST enable → enabled=true', `razorpay=${body.razorpayPlanMonthly || '(existing)'}`);
      enabledOk = true;
    } else {
      FAIL('T2: Admin POST enable → enabled=true', `status=${status} body=${JSON.stringify(body)}`);
    }
  } catch (e) { FAIL('T2: Admin POST enable', e.message); }

  // T3: Public GET — should see plan
  try {
    const { status, body } = await req('GET', '/api/public/hosting-test-plan', null, '');
    if (status === 200 && body.enabled === true && body.plan?.id === 'test_1rs') {
      PASS('T3: Public GET shows enabled plan', `price=₹${body.plan.price} pkg=${body.plan.serverPackage}`);
    } else if (!enabledOk) {
      FAIL('T3: Public GET shows enabled plan', `(T2 failed — plan was never enabled)`);
    } else {
      FAIL('T3: Public GET shows enabled plan', `status=${status} body=${JSON.stringify(body)}`);
    }
  } catch (e) { FAIL('T3: Public GET shows enabled plan', e.message); }

  // T4: Admin GET — confirm enabled
  try {
    const { status, body } = await req('GET', '/api/admin/hosting/test-plan', null, cookie);
    if (status === 200 && body.enabled === true) {
      PASS('T4: Admin GET confirms enabled=true');
    } else {
      FAIL('T4: Admin GET confirms enabled=true', `status=${status} enabled=${body.enabled}`);
    }
  } catch (e) { FAIL('T4: Admin GET confirms enabled=true', e.message); }

  // T5: Admin POST disable
  try {
    const { status, body } = await req('POST', '/api/admin/hosting/test-plan', { action: 'disable' }, cookie);
    if (status === 200 && body.enabled === false) {
      PASS('T5: Admin POST disable → enabled=false');
    } else {
      FAIL('T5: Admin POST disable → enabled=false', `status=${status} body=${JSON.stringify(body)}`);
    }
  } catch (e) { FAIL('T5: Admin POST disable', e.message); }

  // T6: Public GET — should see disabled
  try {
    const { status, body } = await req('GET', '/api/public/hosting-test-plan', null, '');
    if (status === 200 && body.enabled === false) {
      PASS('T6: Public GET shows enabled=false after disable');
    } else {
      FAIL('T6: Public GET shows enabled=false after disable', `status=${status} body=${JSON.stringify(body)}`);
    }
  } catch (e) { FAIL('T6: Public GET shows enabled=false after disable', e.message); }

  // T7: Admin GET — confirm disabled
  try {
    const { status, body } = await req('GET', '/api/admin/hosting/test-plan', null, cookie);
    if (status === 200 && body.enabled === false) {
      PASS('T7: Admin GET confirms enabled=false after disable');
    } else {
      FAIL('T7: Admin GET confirms enabled=false', `status=${status} body=${JSON.stringify(body)}`);
    }
  } catch (e) { FAIL('T7: Admin GET confirms enabled=false', e.message); }

  // T8: Unauthenticated request to admin endpoint → 401
  try {
    const { status } = await req('GET', '/api/admin/hosting/test-plan', null, '');
    if (status === 401 || status === 403) {
      PASS('T8: Unauthenticated admin GET → 401/403', `status=${status}`);
    } else {
      FAIL('T8: Unauthenticated admin GET → 401/403', `status=${status}`);
    }
  } catch (e) { FAIL('T8: Unauthenticated admin GET → 401/403', e.message); }

  // T9: Invalid action → 400
  try {
    const { status, body } = await req('POST', '/api/admin/hosting/test-plan', { action: 'invalid' }, cookie);
    if (status === 400) {
      PASS('T9: Invalid action → 400', body.error || body.message || '');
    } else {
      FAIL('T9: Invalid action → 400', `status=${status}`);
    }
  } catch (e) { FAIL('T9: Invalid action → 400', e.message); }

  console.log(`\n── Results: ${pass} PASS / ${fail} FAIL ──`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
