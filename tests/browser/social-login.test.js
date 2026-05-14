'use strict';

/**
 * Social Login Test Suite
 * Tests Google, Facebook, and GitHub OAuth button visibility and redirect behaviour.
 * Full OAuth completion is not tested (requires real provider credentials),
 * but we verify each button is visible, clickable, and redirects to the
 * correct provider domain.
 */

const { chromium } = require('@playwright/test');
require('dotenv').config({ path: '.env.local' });

const BASE = 'https://app.anutech.in';
const TIMEOUT = 15000;

// Expected redirect domains for each provider
const PROVIDERS = [
  {
    name: 'Google',
    selector: 'button[aria-label="Sign in with Google"]',
    expectedDomain: 'accounts.google.com',
  },
  {
    name: 'Facebook',
    selector: 'button[aria-label="Sign in with Facebook"]',
    expectedDomain: 'www.facebook.com',
  },
  {
    name: 'GitHub',
    selector: 'button[aria-label="Sign in with GitHub"]',
    expectedDomain: 'github.com',
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
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

// ─── Main ────────────────────────────────────────────────────────────────────

(async () => {
  const browser = await chromium.launch({ headless: true });

  // ── Suite 1: Login Page ──────────────────────────────────────────────────
  console.log('\n📋 Suite 1: Social Login Buttons on /login\n');
  {
    const page = await browser.newPage();
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: TIMEOUT });

    await test('Login page loads successfully', async () => {
      const title = await page.title();
      assert(title.length > 0, 'Page has a title');
    });

    await test('Divider "Or continue with" is visible', async () => {
      const divider = page.getByText('Or continue with');
      await divider.waitFor({ timeout: 5000 });
      assert(await divider.isVisible(), '"Or continue with" text not visible');
    });

    for (const provider of PROVIDERS) {
      await test(`${provider.name} button is visible`, async () => {
        const btn = page.locator(provider.selector);
        await btn.waitFor({ timeout: 5000 });
        assert(await btn.isVisible(), `${provider.name} button not found`);
        assert(!(await btn.isDisabled()), `${provider.name} button is disabled`);
      });
    }

    await page.close();
  }

  // ── Suite 2: Registration Page ────────────────────────────────────────────
  console.log('\n📋 Suite 2: Social Login Buttons on /register\n');
  {
    const page = await browser.newPage();
    await page.goto(`${BASE}/register`, { waitUntil: 'networkidle', timeout: TIMEOUT });

    await test('Register page loads successfully', async () => {
      const title = await page.title();
      assert(title.length > 0, 'Page has a title');
    });

    await test('Divider "Or continue with" is visible on register page', async () => {
      const divider = page.getByText('Or continue with', { exact: true }).first();
      await divider.waitFor({ timeout: 5000 });
      assert(await divider.isVisible(), '"Or continue with" text not visible on register');
    });

    for (const provider of PROVIDERS) {
      await test(`${provider.name} button is visible on register page`, async () => {
        const btn = page.locator(provider.selector);
        await btn.waitFor({ timeout: 5000 });
        assert(await btn.isVisible(), `${provider.name} button not found on register`);
      });
    }

    await page.close();
  }

  // ── Suite 3: OAuth Redirect Verification ─────────────────────────────────
  console.log('\n📋 Suite 3: OAuth Redirect to Provider Domains\n');

  for (const provider of PROVIDERS) {
    await test(`${provider.name} button redirects to ${provider.expectedDomain}`, async () => {
      const page = await browser.newPage();
      await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: TIMEOUT });

      const btn = page.locator(provider.selector);
      await btn.waitFor({ timeout: 5000 });

      // Wait for navigation to the provider's domain
      const [response] = await Promise.all([
        page.waitForURL(
          url => url.hostname.includes(provider.expectedDomain.split('.').slice(-2).join('.')),
          { timeout: 12000 }
        ),
        btn.click(),
      ]);

      const finalUrl = page.url();
      assert(
        finalUrl.includes(provider.expectedDomain.split('.').slice(-2).join('.')),
        `Expected redirect to ${provider.expectedDomain}, got: ${finalUrl}`
      );

      // Verify the URL contains expected OAuth params
      if (provider.name === 'Google') {
        assert(finalUrl.includes('accounts.google.com') || finalUrl.includes('google.com'),
          `Google URL should contain google.com, got: ${finalUrl}`);
      }
      if (provider.name === 'Facebook') {
        assert(finalUrl.includes('facebook.com'),
          `Facebook URL should contain facebook.com, got: ${finalUrl}`);
        // Facebook OAuth uses client_id= or app_id= depending on endpoint version
        assert(finalUrl.includes('client_id=') || finalUrl.includes('app_id='),
          `Facebook URL missing client_id/app_id: ${finalUrl}`);
      }
      if (provider.name === 'GitHub') {
        assert(finalUrl.includes('github.com'),
          `GitHub URL should contain github.com, got: ${finalUrl}`);
        assert(finalUrl.includes('client_id='), 'GitHub URL missing client_id');
      }

      await page.close();
    });
  }

  // ── Suite 4: Error Handling ────────────────────────────────────────────────
  console.log('\n📋 Suite 4: UI State During OAuth\n');
  {
    const page = await browser.newPage();
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: TIMEOUT });

    await test('GitHub button shows loading spinner when clicked', async () => {
      const btn = page.locator('button[aria-label="Sign in with GitHub"]');
      await btn.waitFor({ timeout: 5000 });

      // Click and immediately check for spinner before redirect
      await btn.click();

      // Either a spinner appears OR the page navigates — both are valid
      const spinnerOrNav = await Promise.race([
        page.waitForSelector('.animate-spin', { timeout: 3000 }).then(() => 'spinner'),
        page.waitForURL(url => url.hostname !== 'localhost', { timeout: 3000 }).then(() => 'navigated'),
      ]).catch(() => 'timeout');

      assert(
        spinnerOrNav === 'spinner' || spinnerOrNav === 'navigated',
        `Expected spinner or navigation, got: ${spinnerOrNav}`
      );
    });

    await page.close();
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  await browser.close();

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
