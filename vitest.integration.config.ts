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
import os from "os";

/**
 * Bound worker parallelism.
 *
 * Every integration file boots its OWN MongoMemoryServer — a real `mongod`
 * child process — in tests/integration/setup.ts's beforeAll. Vitest defaults
 * maxWorkers to the CPU count, so on a 28-core box that is up to 20 mongod
 * processes plus 20 node forks at once. Under memory pressure the workers get
 * killed before the beforeAll hook resolves and every file fails with
 * "Vitest failed to find the current suite", reporting `Tests no tests`.
 *
 * It presented as flakiness because it is load-dependent: clean on an idle
 * machine, failing when the dev server was up or the 427-file unit suite had
 * just run. 4 is enough to keep the wall-clock win while staying well inside
 * memory, and stays CPU-aware for small CI runners.
 */
const WORKERS = Math.max(1, Math.min(4, os.cpus().length - 1));

export default defineConfig({
  // Own cache bucket — see the matching note in vitest.config.ts.
  cacheDir: "node_modules/.vite/vitest-integration",
  test: {
    environment: "node", // integration tests don't need jsdom
    globals: true,
    setupFiles: ["./tests/integration/setup.ts"],
    include: ["tests/integration/**/*.{test,spec}.{ts,tsx}"],
    // Boot of mongodb-memory-server is ~5-15s on first run; bump the
    // per-test timeout so a slow CI cold-start doesn't false-fail.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // File parallelism enabled — each test file runs in its own worker
    // process (vitest's default isolation:"forks"), so mongoose state and
    // the mongodb-memory-server instance are per-file. Suites can't step
    // on each other's data. At the current 15-file count the boot cost
    // roughly cancels the runtime savings (parallel ~35s vs serial ~33s on
    // the dev box), but the architecture is correct for when the suite
    // grows; raising the count to ~30 files should show real parallel
    // savings.
    fileParallelism: true,
    // ...but bounded. See WORKERS above: one mongod per file means unbounded
    // parallelism is a memory cliff, not a speedup.
    pool: "forks",
    maxWorkers: WORKERS,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
