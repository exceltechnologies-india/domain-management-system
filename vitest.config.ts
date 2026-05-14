import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

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
        // Infrastructure files that require live external services or are
        // mostly regex-pattern data — covered by integration tests, not units.
        "lib/pricing-service.ts",
        "lib/security.ts",
      ],
    },
    include: ["tests/unit/**/*.{test,spec}.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
