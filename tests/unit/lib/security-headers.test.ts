/**
 * Tests for `@/lib/security-headers` (rescan-4 slice 7dd).
 * Backwards-compat barrel that re-exports the security-header utilities
 * from `@/lib/security/headers`. Pins the export contract so a future
 * rename of any of the 3 re-exported functions surfaces here.
 */
import { describe, it, expect } from "vitest";
import * as barrel from "@/lib/security-headers";
import * as real from "@/lib/security/headers";

describe("security-headers (barrel)", () => {
  it("re-exports addSecurityHeaders, referentially identical", () => {
    expect(typeof barrel.addSecurityHeaders).toBe("function");
    expect(barrel.addSecurityHeaders).toBe(real.addSecurityHeaders);
  });

  it("re-exports addCorsHeaders, referentially identical", () => {
    expect(typeof barrel.addCorsHeaders).toBe("function");
    expect(barrel.addCorsHeaders).toBe(real.addCorsHeaders);
  });

  it("re-exports buildPreflightResponse, referentially identical", () => {
    expect(typeof barrel.buildPreflightResponse).toBe("function");
    expect(barrel.buildPreflightResponse).toBe(real.buildPreflightResponse);
  });
});
