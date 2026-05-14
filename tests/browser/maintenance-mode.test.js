'use strict';

/**
 * Maintenance Mode Test Suite
 *
 * Tests the full lifecycle:
 *   Status API · page render (both states) · middleware redirect enforcement ·
 *   admin bypass · scheduled-end auto-disable · site restore after disabling
 *
 * Data setup/teardown: directly updates the Settings collection in MongoDB
 * (same database the application reads from) so we don't need to authenticate
 * through the reCAPTCHA-protected admin UI.
 *
 * Middleware cache: 15 s TTL — suites that check redirect behaviour wait 18 s.
 */

const { chromium } = require('@playwright/test');
const mongoose     = require('mongoose');
require('dotenv').config({ path: '.env.local' });

const BASE          = 'https://app.anutech.in';
const TIMEOUT       = 20000;
const CACHE_WAIT_MS = 18000;
const TEST_MESSAGE  = 'Automated test maintenance — system upgrade in progress.';
const MONGO_URI     = process.env.MONGODB_URI;

// ─── Test harness ─────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const results = [];

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ PASS  ${name}`);
    results.push({ name, status: 'PASS' });
    passed++;
  } catch (err) {
    console.log(`  ❌ FAIL  ${name}`);
    console.log(`         ${err.message}`);
    results.push({ name, status: 'FAIL', error: err.message });
    failed++;
  }
}

// ─── MongoDB helpers ──────────────────────────────────────────────────────────

async function connectMongo() {
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
}

async function disconnectMongo() {
  await mongoose.disconnect().catch(() => {});
}

async function setMaintenanceInDB(enabled, message = '', scheduledEnd = null) {
  await connectMongo();
  await mongoose.connection.db.collection('settings').findOneAndUpdate(
    { key: 'maintenance_mode' },
    {
      $set: {
        key: 'maintenance_mode',
        value: { enabled, message, scheduledEnd },
        description: 'Site-wide maintenance mode configuration',
        category: 'general',
        updatedAt: new Date(),
        updatedBy: 'test-runner',
      },
    },
    { upsert: true }
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  // Ensure maintenance is OFF before we start (in case a previous run left it on)
  await connectMongo();
  await setMaintenanceInDB(false, '');
  console.log('  ℹ️  DB reset: maintenance_mode = false\n');

  const browser = await chromium.launch({ headless: true });

  try {
    // ── Suite 1: Maintenance Status API ────────────────────────────────────
    console.log('📋 Suite 1: Maintenance Status API\n');
    {
      const page = await browser.newPage();

      await test('GET /api/public/maintenance-status returns valid JSON', async () => {
        const res = await page.request.get(`${BASE}/api/public/maintenance-status`);
        assert(res.ok(), `HTTP ${res.status()}`);
        const data = await res.json();
        assert(typeof data.enabled  === 'boolean', `enabled must be boolean`);
        assert(typeof data.message  === 'string',  `message must be string`);
      });

      await test('Maintenance mode is off at test start', async () => {
        const res  = await page.request.get(`${BASE}/api/public/maintenance-status`);
        const data = await res.json();
        assert(data.enabled === false, `Expected false, got ${data.enabled}`);
      });

      await test('Status API is accessible without authentication', async () => {
        const ctx = await browser.newContext();
        const p   = await ctx.newPage();
        const res = await p.request.get(`${BASE}/api/public/maintenance-status`);
        assert(res.ok(), `Expected 200, got HTTP ${res.status()}`);
        await p.close();
        await ctx.close();
      });

      await page.close();
    }

    // ── Suite 2: Maintenance Page — Site Live State ───────────────────────
    console.log('\n📋 Suite 2: Maintenance Page — Site Live State\n');
    {
      const page = await browser.newPage();
      await page.goto(`${BASE}/maintenance`, { waitUntil: 'networkidle', timeout: TIMEOUT });

      await test('GET /maintenance returns 200', async () => {
        const res = await page.request.get(`${BASE}/maintenance`);
        assert(res.ok(), `HTTP ${res.status()}`);
      });

      await test('"Site is Operating Normally" shown when maintenance is off', async () => {
        const h = page.getByText('Site is Operating Normally');
        await h.waitFor({ timeout: 8000 });
        assert(await h.isVisible(), 'Expected site-live state heading');
      });

      await test('"Go to Homepage" link is present', async () => {
        const link = page.getByRole('link', { name: /go to homepage/i });
        await link.waitFor({ timeout: 5000 });
        assert(await link.isVisible(), '"Go to Homepage" not found');
      });

      await page.close();
    }

    // ── Suite 3: Enable Maintenance via DB ───────────────────────────────
    console.log('\n📋 Suite 3: Enable Maintenance Mode (DB direct)\n');
    {
      await test('DB update: maintenance_mode = true', async () => {
        await setMaintenanceInDB(true, TEST_MESSAGE);
        // Verify via the status API
        const page = await browser.newPage();
        const res  = await page.request.get(`${BASE}/api/public/maintenance-status`);
        const data = await res.json();
        await page.close();
        assert(data.enabled === true,       `Expected true, got ${data.enabled}`);
        assert(data.message === TEST_MESSAGE, `Expected custom message`);
      });
    }

    // ── Suite 4: Redirect Enforcement (wait for middleware cache) ─────────
    console.log(`\n📋 Suite 4: Middleware Redirect (waiting ${CACHE_WAIT_MS / 1000}s for cache expiry)\n`);
    await new Promise(r => setTimeout(r, CACHE_WAIT_MS));

    {
      const userCtx  = await browser.newContext();
      const userPage = await userCtx.newPage();

      await test('/ redirects unauthenticated visitor to /maintenance', async () => {
        await userPage.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: TIMEOUT });
        assert(userPage.url().includes('/maintenance'), `Got ${userPage.url()}`);
      });

      await test('/login is NOT redirected (accessible so admins can authenticate)', async () => {
        // /login bypasses maintenance so admins can log in and then reach /admin
        await userPage.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: TIMEOUT });
        assert(!userPage.url().includes('/maintenance'), `Login should bypass maintenance, got ${userPage.url()}`);
        assert(userPage.url().includes('/login'), `Should stay on /login, got ${userPage.url()}`);
      });

      await test('/domains/search redirects to /maintenance', async () => {
        await userPage.goto(`${BASE}/domains/search`, { waitUntil: 'networkidle', timeout: TIMEOUT });
        assert(userPage.url().includes('/maintenance'), `Got ${userPage.url()}`);
      });

      await test('/hosting redirects to /maintenance', async () => {
        await userPage.goto(`${BASE}/hosting`, { waitUntil: 'networkidle', timeout: TIMEOUT });
        assert(userPage.url().includes('/maintenance'), `Got ${userPage.url()}`);
      });

      await test('Maintenance page shows "We\'re Under Maintenance" heading', async () => {
        await userPage.goto(`${BASE}/maintenance`, { waitUntil: 'networkidle', timeout: TIMEOUT });
        const h = userPage.getByText("We're Under Maintenance");
        await h.waitFor({ timeout: 8000 });
        assert(await h.isVisible(), 'Maintenance heading not visible');
      });

      await test('Custom message is shown on the maintenance page', async () => {
        const msg = userPage.getByText(TEST_MESSAGE);
        await msg.waitFor({ timeout: 5000 });
        assert(await msg.isVisible(), 'Custom message not visible');
      });

      await test('"Try Again" button is visible', async () => {
        const btn = userPage.getByRole('button', { name: /try again/i });
        await btn.waitFor({ timeout: 5000 });
        assert(await btn.isVisible(), '"Try Again" not found');
      });

      await test('"Admin Access" link points to /admin', async () => {
        const link = userPage.getByRole('link', { name: /admin access/i });
        await link.waitFor({ timeout: 5000 });
        const href = await link.getAttribute('href');
        assert(href === '/admin', `Expected /admin, got ${href}`);
      });

      await test('/api/public/maintenance-status is accessible during maintenance', async () => {
        const res  = await userPage.request.get(`${BASE}/api/public/maintenance-status`);
        assert(res.ok(), `HTTP ${res.status()}`);
        const data = await res.json();
        assert(data.enabled === true, `Expected true, got ${data.enabled}`);
      });

      await test('/maintenance has no redirect loop', async () => {
        // Navigate directly — should NOT redirect again
        await userPage.goto(`${BASE}/maintenance`, { waitUntil: 'networkidle', timeout: TIMEOUT });
        assert(userPage.url().includes('/maintenance'), `Looped away: ${userPage.url()}`);
      });

      await userPage.close();
      await userCtx.close();
    }

    // ── Suite 5: Admin /admin/* Bypass During Maintenance ────────────────
    console.log('\n📋 Suite 5: Admin Bypass (maintenance still on)\n');
    {
      // /admin itself is blocked by auth (no session), but the middleware should
      // NOT redirect to /maintenance — it should redirect to /login instead,
      // proving the maintenance bypass is working correctly for /admin paths.
      const page = await browser.newPage();

      await test('/admin/* is NOT redirected to /maintenance (goes to /login instead)', async () => {
        await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle', timeout: TIMEOUT });
        const url = page.url();
        assert(
          !url.includes('/maintenance'),
          `Admin path should bypass maintenance redirect, got ${url}`
        );
        // Expected: redirected to /login (not /maintenance and not /admin without session)
        assert(
          url.includes('/login') || url.includes('/admin'),
          `Expected /login or /admin, got ${url}`
        );
      });

      await test('/api/admin/* returns 401 (not maintenance redirect)', async () => {
        // API routes bypass maintenance — should get 401 (unauthorized) not a redirect
        const res = await page.request.get(`${BASE}/api/admin/settings`);
        assert(
          res.status() === 401,
          `Expected 401 (not maintenance redirect), got ${res.status()}`
        );
      });

      await page.close();
    }

    // ── Suite 6: Scheduled End Auto-Disable ──────────────────────────────
    console.log('\n📋 Suite 6: Scheduled End Auto-Disable\n');
    {
      const pastTime = new Date(Date.now() - 10000).toISOString(); // 10 s in the past

      await test('DB: set scheduledEnd in the past → status API auto-disables', async () => {
        await setMaintenanceInDB(true, 'Past-end test', pastTime);

        const page = await browser.newPage();
        // The status endpoint detects expired scheduledEnd and writes enabled=false back
        const res  = await page.request.get(`${BASE}/api/public/maintenance-status`);
        const data = await res.json();
        await page.close();
        assert(data.enabled === false, `Expected auto-disable, got ${data.enabled}`);
      });

      await test('DB: re-enable for disable test', async () => {
        // Re-enable so we can test a proper disable
        await setMaintenanceInDB(true, TEST_MESSAGE);
        const page = await browser.newPage();
        const res  = await page.request.get(`${BASE}/api/public/maintenance-status`);
        const data = await res.json();
        await page.close();
        assert(data.enabled === true, `Expected true after re-enable`);
      });
    }

    // ── Suite 7: Disable Maintenance ─────────────────────────────────────
    console.log('\n📋 Suite 7: Disable Maintenance Mode\n');
    {
      await test('DB update: maintenance_mode = false', async () => {
        await setMaintenanceInDB(false, '');
        const page = await browser.newPage();
        const res  = await page.request.get(`${BASE}/api/public/maintenance-status`);
        const data = await res.json();
        await page.close();
        assert(data.enabled === false, `Expected false, got ${data.enabled}`);
      });
    }

    // ── Suite 8: Site Accessible Again ───────────────────────────────────
    console.log(`\n📋 Suite 8: Site Accessible Again (waiting ${CACHE_WAIT_MS / 1000}s)\n`);
    await new Promise(r => setTimeout(r, CACHE_WAIT_MS));

    {
      const userCtx  = await browser.newContext();
      const userPage = await userCtx.newPage();

      await test('/ loads normally after maintenance is disabled', async () => {
        await userPage.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: TIMEOUT });
        assert(!userPage.url().includes('/maintenance'), `Got ${userPage.url()}`);
      });

      await test('/login accessible normally', async () => {
        await userPage.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: TIMEOUT });
        assert(!userPage.url().includes('/maintenance'), `Got ${userPage.url()}`);
      });

      await test('/maintenance shows "Site is Operating Normally"', async () => {
        await userPage.goto(`${BASE}/maintenance`, { waitUntil: 'networkidle', timeout: TIMEOUT });
        const h = userPage.getByText('Site is Operating Normally');
        await h.waitFor({ timeout: 8000 });
        assert(await h.isVisible(), 'Site-live state not shown');
      });

      await userPage.close();
      await userCtx.close();
    }

  } finally {
    // Always clean up — ensure maintenance is off even if a test throws
    await setMaintenanceInDB(false, '').catch(() => {});
    await disconnectMongo();
    await browser.close();
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(55));
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(55));

  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  • ${r.name}: ${r.error}`);
    });
    process.exit(1);
  }
})();
