'use strict';
const puppeteer = require('puppeteer');
const mongoose  = require('mongoose');
const bcrypt    = require('bcryptjs');
require('dotenv').config({ path: '.env.local' });

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const User = mongoose.models.User || mongoose.model('User', new mongoose.Schema({}, { strict: false }));
  await User.deleteOne({ email: 'domi@test.com' });
  const hash = await bcrypt.hash('DomInspect@2025', 10);
  await User.create({
    email: 'domi@test.com', password: hash,
    firstName: 'Dom', lastName: 'Inspector',
    phone: '9876543210', phoneCc: '+91', role: 'user',
    isActivated: true, isActive: true, profileCompleted: true, provider: 'credentials',
    address: { line1: 'Test', city: 'Mumbai', state: 'Maha', country: 'India', zipcode: '400001' }
  });
  await mongoose.disconnect();

  const b = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const p = await b.newPage();

  // Login
  await p.goto('http://localhost:3001/login', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await p.waitForSelector('input[name="email"]', { timeout: 15000 });
  await p.type('input[name="email"]', 'domi@test.com');
  await p.type('input[name="password"]', 'DomInspect@2025');
  const allBtns = await p.$$('button');
  for (const btn of allBtns) {
    const t = await btn.evaluate(e => e.textContent.trim());
    if (t === 'Sign in') { await btn.click(); break; }
  }
  await p.waitForFunction(() => location.href.includes('/dashboard'), { timeout: 25000 });
  process.stdout.write('LOGIN_OK url=' + p.url() + '\n');

  // Search page buttons after results load
  await p.goto('http://localhost:3001/domains/search?q=inspecttestxyz9999', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await p.waitForFunction(
    () => document.body.innerText.includes('inspecttestxyz9999.com') || document.body.innerText.includes('₹'),
    { timeout: 30000 }
  ).catch(() => {});
  const searchBtns = await p.evaluate(() =>
    [...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(t => t)
  );
  const prices = await p.evaluate(() => (document.body.innerText.match(/₹[\d,. ]+/g) || []).slice(0, 3));
  process.stdout.write('SEARCH_BTNS ' + JSON.stringify(searchBtns) + '\n');
  process.stdout.write('SEARCH_PRICES ' + JSON.stringify(prices) + '\n');

  // Dashboard
  await p.goto('http://localhost:3001/dashboard', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await p.waitForFunction(() => !location.href.includes('/login'), { timeout: 10000 }).catch(() => {});
  const dashText = await p.evaluate(() => document.body.innerText.slice(0, 300));
  process.stdout.write('DASHBOARD ' + JSON.stringify(dashText) + '\n');

  // Settings inputs & buttons
  await p.goto('http://localhost:3001/dashboard/settings', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await p.waitForFunction(() => document.querySelectorAll('input').length > 3, { timeout: 15000 }).catch(() => {});
  const settInputs = await p.evaluate(() =>
    [...document.querySelectorAll('input')].map(i => 'name=' + i.name + ' type=' + i.type)
  );
  const settBtns = await p.evaluate(() =>
    [...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(t => t)
  );
  process.stdout.write('SETTINGS_INPUTS ' + JSON.stringify(settInputs) + '\n');
  process.stdout.write('SETTINGS_BTNS ' + JSON.stringify(settBtns) + '\n');

  // Checkout page
  await p.goto('http://localhost:3001/checkout', { waitUntil: 'domcontentloaded', timeout: 40000 });
  const checkText = await p.evaluate(() => document.body.innerText.slice(0, 300));
  const checkBtns = await p.evaluate(() =>
    [...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(t => t)
  );
  process.stdout.write('CHECKOUT_TEXT ' + JSON.stringify(checkText) + '\n');
  process.stdout.write('CHECKOUT_BTNS ' + JSON.stringify(checkBtns) + '\n');

  // Logout/signout nav buttons
  await p.goto('http://localhost:3001/dashboard', { waitUntil: 'domcontentloaded', timeout: 40000 });
  const logoutBtns = await p.evaluate(() =>
    [...document.querySelectorAll('button,a')].map(e => e.textContent.trim())
      .filter(t => /logout|sign.?out/i.test(t))
  );
  process.stdout.write('LOGOUT_BTNS ' + JSON.stringify(logoutBtns) + '\n');

  await b.close();
  await mongoose.connect(process.env.MONGODB_URI);
  const U2 = mongoose.models.User || mongoose.model('User', new mongoose.Schema({}, { strict: false }));
  await U2.deleteOne({ email: 'domi@test.com' });
  await mongoose.disconnect();
  process.stdout.write('INSPECT_DONE\n');
})().catch(e => { process.stdout.write('INSPECT_ERR ' + e.message + '\n'); process.exit(1); });
