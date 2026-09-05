import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";
import os from "os";

/**
 * Bound worker parallelism.
 *
 * Vitest defaults maxWorkers to the CPU count. On a 28-core dev box that is 28
 * concurrent forks, each booting its own jsdom environment for 427 test files —
 * enough memory pressure that workers get killed mid-run and the whole suite
 * dies with "Vitest failed to find the current suite" and `Tests no tests`.
 * It is load-dependent, so it looked flaky: fine on an idle machine, failing as
 * soon as the dev server or a second suite was also running.
 *
 * Capped at 4, not 8. 8 was tried first and measurably helped (39 -> 22
 * processes, 7.2GB -> 4.8GB peak) but STILL produced intermittent
 * "Worker exited unexpectedly" / "failed to find the runner" deaths — three
 * separate occurrences, including one that killed all 427 files at once with
 * 14GB free. 4 is the value this project's own 2026-08-11 investigation
 * landed on. It costs ~47s on this box (76s -> 123s) and buys a suite that
 * stops eating its own runs; a test suite you cannot trust to complete is
 * worth far less than 47 seconds.
 *
 * Kept CPU-aware so a 2-core CI runner does not oversubscribe either.
 */
const WORKERS = Math.max(1, Math.min(4, os.cpus().length - 1));

export default defineConfig({
  plugins: [react()],
  // Own cache bucket. Both vitest configs otherwise resolve to the SAME
  // node_modules/.vite/vitest/<hash> directory, so a unit run and an
  // integration run touching it at once contend on Vite's dep-optimizer
  // cache. Cheap to separate; removes one shared-mutable-state hazard
  // between two suites that are frequently run back-to-back.
  cacheDir: "node_modules/.vite/vitest-unit",
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/unit/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      thresholds: { lines: 60, functions: 60, branches: 60, statements: 60 },
      exclude: [
        "node_modules/**",
        "tests/**",
        "*.config.*",
        ".next/**",
        "scripts/**",
        // Pricing-service requires a live external API to exercise meaningfully;
        // covered by integration tests, not units.
        "lib/pricing-service.ts",
      ],
    },
    include: ["tests/unit/**/*.{test,spec}.{ts,tsx}"],
    // See WORKERS above — unbounded parallelism OOMs this suite.
    pool: "forks",
    maxWorkers: WORKERS,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
