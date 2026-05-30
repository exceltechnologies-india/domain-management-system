/**
 * Tests for `@/lib/auth-secret` (rescan-4 slice 7dg).
 * Pins the boot-time NEXTAUTH_SECRET guard + the trim() call.
 *
 * The module is tiny but load-bearing — every JWT path (NextAuth +
 * guest-token) reads AUTH_SECRET. A missing env should fail fast at
 * boot, not silently produce broken signatures at runtime.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("@/lib/auth-secret", () => {
  it("exports AUTH_SECRET when NEXTAUTH_SECRET is set", async () => {
    vi.stubEnv("NEXTAUTH_SECRET", "test-secret-value");
    const mod = await import("@/lib/auth-secret");
    expect(mod.AUTH_SECRET).toBe("test-secret-value");
  });

  it("trims surrounding whitespace from NEXTAUTH_SECRET", async () => {
    vi.stubEnv("NEXTAUTH_SECRET", "  padded-secret\n");
    const mod = await import("@/lib/auth-secret");
    expect(mod.AUTH_SECRET).toBe("padded-secret");
  });

  it("throws at module load when NEXTAUTH_SECRET is unset", async () => {
    vi.stubEnv("NEXTAUTH_SECRET", "");
    await expect(import("@/lib/auth-secret")).rejects.toThrow(
      /NEXTAUTH_SECRET environment variable is not set/
    );
  });
});
