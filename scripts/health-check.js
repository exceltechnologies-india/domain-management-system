#!/usr/bin/env node
/**
 * Health Check Script
 * Verifies connectivity to MongoDB, Redis (Upstash), ResellerClub API, and DirectAdmin.
 *
 * Usage:
 *   node scripts/health-check.js
 *   node scripts/health-check.js --json       (structured JSON output)
 *   node scripts/health-check.js --dry-run    (skip live API calls, check config only)
 */

const path = require('path');
const fs = require('fs');

const envPath = path.resolve(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
} else {
  console.error('❌ .env.local not found at', envPath);
  process.exit(1);
}

const args = process.argv.slice(2);
const JSON_OUTPUT = args.includes('--json');
const DRY_RUN = args.includes('--dry-run');

const results = [];

function log(service, status, message, detail) {
  const entry = { service, status, message, ...(detail ? { detail } : {}) };
  results.push(entry);
  if (!JSON_OUTPUT) {
    const icon = status === 'ok' ? '✅' : status === 'warn' ? '⚠️ ' : '❌';
    console.log(`${icon} [${service}] ${message}${detail ? ' — ' + detail : ''}`);
  }
}

// ── MongoDB ──────────────────────────────────────────────────────────────────
async function checkMongo() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    log('MongoDB', 'error', 'MONGODB_URI not set');
    return;
  }
  if (DRY_RUN) { log('MongoDB', 'warn', 'dry-run — skipped live check'); return; }

  const { MongoClient } = require('mongodb');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    await client.db().command({ ping: 1 });
    log('MongoDB', 'ok', 'connected');
  } catch (err) {
    log('MongoDB', 'error', 'connection failed', err.message);
  } finally {
    await client.close().catch(() => {});
  }
}

// ── Redis (Upstash) ───────────────────────────────────────────────────────────
async function checkRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    log('Redis', 'error', 'UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN not set');
    return;
  }
  if (DRY_RUN) { log('Redis', 'warn', 'dry-run — skipped live check'); return; }

  const https = require('https');
  await new Promise((resolve) => {
    const req = https.request(
      `${url}/ping`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          if (res.statusCode === 200) {
            log('Redis', 'ok', 'connected', body.trim());
          } else {
            log('Redis', 'error', `unexpected status ${res.statusCode}`, body.trim());
          }
          resolve();
        });
      }
    );
    req.on('error', (err) => { log('Redis', 'error', 'connection failed', err.message); resolve(); });
    req.on('timeout', () => { log('Redis', 'error', 'timeout after 5s'); req.destroy(); resolve(); });
    req.end();
  });
}

// ── ResellerClub ──────────────────────────────────────────────────────────────
async function checkResellerClub() {
  const apiUrl = process.env.RESELLERCLUB_API_URL;
  const id = process.env.RESELLERCLUB_ID;
  const key = process.env.RESELLERCLUB_SECRET;
  if (!apiUrl || !id || !key) {
    log('ResellerClub', 'error', 'RESELLERCLUB_API_URL / ID / SECRET not set');
    return;
  }
  if (DRY_RUN) { log('ResellerClub', 'warn', 'dry-run — skipped live check'); return; }

  const axios = require('axios');
  try {
    const start = Date.now();
    await axios.get(`${apiUrl}/api/domains/available.json`, {
      params: { 'auth-userid': id, 'api-key': key, 'domain-name': 'example', tlds: 'com' },
      timeout: 10000,
    });
    log('ResellerClub', 'ok', `reachable (${Date.now() - start}ms)`);
  } catch (err) {
    const status = err.response?.status;
    if (status === 400 || status === 422) {
      // Bad params but API is reachable — that's fine for a health check
      log('ResellerClub', 'ok', `API reachable (HTTP ${status} on probe request)`);
    } else {
      log('ResellerClub', 'error', 'connection failed', err.message);
    }
  }
}

// ── DirectAdmin ───────────────────────────────────────────────────────────────
async function checkDirectAdmin() {
  const daUrl = process.env.DIRECTADMIN_URL;
  const user = process.env.DIRECTADMIN_ADMIN_USER;
  const key = process.env.DIRECTADMIN_API_KEY;
  if (!daUrl || !user || !key) {
    log('DirectAdmin', 'error', 'DIRECTADMIN_URL / ADMIN_USER / API_KEY not set');
    return;
  }
  if (DRY_RUN) { log('DirectAdmin', 'warn', 'dry-run — skipped live check'); return; }

  const axios = require('axios');
  try {
    const start = Date.now();
    await axios.get(`${daUrl}/CMD_API_SHOW_ALL_USERS`, {
      auth: { username: user, password: key },
      timeout: 8000,
      params: { json: 'yes' },
    });
    log('DirectAdmin', 'ok', `reachable (${Date.now() - start}ms)`);
  } catch (err) {
    const status = err.response?.status;
    if (status === 403) {
      log('DirectAdmin', 'warn', 'reachable but credentials rejected (403)');
    } else {
      log('DirectAdmin', 'error', 'connection failed', err.message);
    }
  }
}

// ── Run all checks ────────────────────────────────────────────────────────────
(async () => {
  if (!JSON_OUTPUT) {
    console.log(`\n🔍 Health Check${DRY_RUN ? ' (dry-run)' : ''}\n${'─'.repeat(40)}`);
  }

  await Promise.all([checkMongo(), checkRedis(), checkResellerClub(), checkDirectAdmin()]);

  const errors = results.filter((r) => r.status === 'error').length;
  const warnings = results.filter((r) => r.status === 'warn').length;

  if (JSON_OUTPUT) {
    console.log(JSON.stringify({ results, errors, warnings }, null, 2));
  } else {
    console.log(`\n${'─'.repeat(40)}`);
    console.log(`${errors === 0 ? '✅' : '❌'} ${errors} error(s), ${warnings} warning(s)`);
  }

  process.exit(errors > 0 ? 1 : 0);
})();
