/**
 * Integration-test setup: boots mongodb-memory-server before all tests,
 * connects mongoose to it, tears down after.
 *
 * Each integration test file gets a fresh DB state via the
 * `clearAllCollections()` helper (called from a `beforeEach` in each file)
 * so suites don't leak fixture data into each other.
 *
 * Required env defaults so route-handler imports (which evaluate
 * `process.env.X` at module load) don't blow up. Tests can override
 * individual env vars before importing the handler under test.
 */
import { afterAll, beforeAll, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

// Required env vars that route handlers / lib modules expect at import time.
// Set BEFORE any test-side imports of those modules. MONGODB_URI gets a
// placeholder here so the lib/mongodb.ts module-load assertion passes;
// the real URI is set inside beforeAll once mongodb-memory-server boots
// (mongoose.connect happens there too, so the placeholder is never used).
// @types/node 24+ types NODE_ENV as read-only; tests legitimately need to
// set it before any module evaluates `process.env.NODE_ENV` at load time.
(process.env as Record<string, string>).NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://placeholder-set-in-beforeAll/test";
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID ?? "rzp_test_keyid";
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET ?? "rzp_test_secret";
process.env.RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? "rzp_test_webhook";
process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? "test_nextauth_secret_at_least_32_chars_long_x";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test_jwt_secret_at_least_32_chars_long_padding";
process.env.NEXTAUTH_URL = process.env.NEXTAUTH_URL ?? "http://localhost:3000";

let mongo: MongoMemoryServer | undefined;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();
  // mongodb-memory-server doesn't ship a default DB name; pick a stable
  // one so any direct connection string assertions in test code match.
  process.env.MONGODB_URI = uri;
  await mongoose.connect(uri);
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

// ── Per-suite helpers ────────────────────────────────────────────────────────
//
// Exported for use in individual integration test files. The pattern is:
//   import { clearAllCollections } from "@/tests/integration/setup";
//   beforeEach(clearAllCollections);
// so each test starts with an empty DB.

/**
 * Wipe every collection in the in-memory DB. Faster than dropping the
 * database (no need to re-create indexes on every test).
 */
export async function clearAllCollections() {
  const collections = await mongoose.connection.db?.collections();
  if (!collections) return;
  for (const collection of collections) {
    await collection.deleteMany({});
  }
}

// ── Mocks shared across all integration suites ───────────────────────────────
//
// These external services aren't part of the route's surface we're testing —
// they're side-effecting calls we don't want hitting the network in CI.
// Suites that DO want to assert on them can vi.spyOn within their file.

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), log: vi.fn() },
}));

vi.mock("@/lib/redis", () => ({
  redis: {
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    ttl: vi.fn(async () => 60),
    set: vi.fn(async () => "OK"),
    get: vi.fn(async () => null),
    del: vi.fn(async () => 1),
  },
  redisCache: {
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    del: vi.fn(async () => undefined),
  },
}));

// @/lib/mongodb captures process.env.MONGODB_URI at module-load (before
// beforeAll runs), so its own connect() would point at the placeholder URI.
// Bypass it — mongoose is already connected to mongodb-memory-server via
// beforeAll, so a no-op is the correct behaviour for tests.
vi.mock("@/lib/mongodb", () => ({
  default: vi.fn(async () => undefined),
}));
