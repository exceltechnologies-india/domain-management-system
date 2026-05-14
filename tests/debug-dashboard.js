const { chromium } = require('@playwright/test');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config({ path: '.env.local' });

const BASE = 'http://localhost:3000';
const clickByText = (page, frag) => page.evaluate((f) => {
  const el = [...document.querySelectorAll('button, a')].find(e =>
    e.textContent.trim().toLowerCase().includes(f.toLowerCase()));
  if (el) { el.click(); return true; } return false;
}, frag);

(async () => {
  const TS = Date.now();
  const email = `dbg_${TS}@anutech-test.com`;
  const pass = 'Debug@2025x!';

  await mongoose.connect(process.env.MONGODB_URI);
  const User = mongoose.models.User || mongoose.model('User', new mongoose.Schema({},{strict:false}));
  // Purge stale debug users from previous interrupted runs
  await User.deleteMany({ email: { $regex: /^dbg_.*@anutech-test\.com$/i } });
  await User.create({ email, password: await bcrypt.hash(pass, 10), firstName: 'Debug', lastName: 'User',
    phone: '9876543210', phoneCc: '+91', role: 'user', isActivated: true, isActive: true,
    profileCompleted: true, provider: 'credentials',
    address: { line1: '1 St', city: 'Mumbai', state: 'Maharashtra', country: 'India', zipcode: '400001' } });
  await mongoose.disconnect();

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) console.log('Navigation to:', frame.url());
  });

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('input[name="email"]', { timeout: 15000 });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', pass);
  await page.waitForTimeout(2000);
  await clickByText(page, 'sign in');
  await page.waitForFunction(() => window.location.href.includes('/dashboard'), { timeout: 25000 });
  console.log('Reached dashboard.');

  // Poll body text, capture URL on every change
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(500);
    const url = page.url();
    const text = await page.evaluate(() => document.body.innerText.slice(0, 100)).catch(() => 'N/A (navigated away)');
    console.log(`t=${i*0.5}s url=${url.replace(BASE,'')} text="${text.replace(/\n/g,' ').slice(0,80)}"`);
    if (!url.includes('/dashboard')) break;
    if (!text.includes('Loading')) break;
  }

  const finalText = await page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => 'N/A');
  console.log('\nFinal body:', finalText.slice(0, 300));

  await browser.close();
  await mongoose.connect(process.env.MONGODB_URI);
  const U = mongoose.model('UC5', new mongoose.Schema({},{strict:false}), 'users');
  await U.deleteOne({ email });
  await mongoose.disconnect();
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
