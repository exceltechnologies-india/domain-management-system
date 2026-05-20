/**
 * Vitest config for route-level integration tests.
 *
 * Separate from the main vitest.config.ts because integration tests need:
 *   - A real mongoose connection (the unit-test config mocks mongoose so models
 *     don't try to connect — integration tests use mongodb-memory-server
 *     instead, which the setup file boots before any test runs).
 *   - NextResponse from "next/server" NOT mocked (the unit-test config stubs
 *     it; integration tests need the real .json()/.redirect() so we can
 *     introspect what the route handler actually returned).
 *
 * Test layout: tests/integration/**.test.ts — kept apart from tests/unit/**
 * so the two configs don't fight over setup files.
 */
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node", // integration tests don't need jsdom
    globals: true,
    setupFiles: ["./tests/integration/setup.ts"],
    include: ["tests/integration/**/*.{test,spec}.{ts,tsx}"],
    // Boot of mongodb-memory-server is ~5-15s on first run; bump the
    // per-test timeout so a slow CI cold-start doesn't false-fail.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Run serially — the in-memory Mongo is shared across files so parallel
    // suites would step on each other's data. Cheap enough to serialize.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
