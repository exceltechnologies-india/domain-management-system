/**
 * Production keeps server errors and warnings (9 Oct 2026). `compiler.removeConsole: true`
 * stripped every console call from the server bundle too, so a serverLogger.error() on the live
 * site printed nothing.
 */
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("next.config removeConsole", () => {
  it("keeps console.error and console.warn in production", () => {
    const src = readFileSync("next.config.js", "utf8");
    expect(src).toMatch(/removeConsole:\s*process\.env\.NODE_ENV === "production" \? \{ exclude: \["error", "warn"\] \} : false/);
  });
});
