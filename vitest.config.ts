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
 * Cap at 8 (still parallel, ~4GB peak instead of ~14GB) and keep it CPU-aware
 * so a 2-core CI runner does not oversubscribe either.
 */
const WORKERS = Math.max(1, Math.min(8, os.cpus().length - 1));

export default defineConfig({
  plugins: [react()],
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
