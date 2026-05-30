/**
 * Tests for `@/lib/cron-auth` (rescan-4 slice 7df).
 * The cron/worker route authorisation helper. Pins:
 *  - No env → false (never throws)
 *  - Empty header → false (length mismatch short-circuit before
 *    timingSafeEqual)
 *  - Length mismatch → false
 *  - Correct secret → true (constant-time compare)
 *  - timingSafeEqual throw on weird inputs → caught + returns false
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { authorizeCronRequest } from "@/lib/cron-auth";

function reqWith(header?: string): { headers: Headers } {
  const headers = new Headers();
  if (header !== undefined) headers.set("x-cron-secret", header);
  return { headers };
}

beforeEach(() => {
  // Default: a known cron secret.
  vi.stubEnv("CRON_SECRET", "expected-secret-value");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("authorizeCronRequest", () => {
  it("CRON_SECRET unset → false (no throw)", () => {
    vi.stubEnv("CRON_SECRET", "");
    expect(authorizeCronRequest(reqWith("any") as never)).toBe(false);
  });

  it("missing header → false (treated as length 0 vs N)", () => {
    expect(authorizeCronRequest(reqWith() as never)).toBe(false);
  });

  it("length mismatch → false (no timingSafeEqual call)", () => {
    expect(authorizeCronRequest(reqWith("short") as never)).toBe(false);
  });

  it("matching secret → true (constant-time compare)", () => {
    expect(
      authorizeCronRequest(reqWith("expected-secret-value") as never)
    ).toBe(true);
  });

  it("wrong secret of equal length → false (timing-safe compare fails)", () => {
    expect(
      authorizeCronRequest(reqWith("wrongggg-secret-valuw") as never)
    ).toBe(false);
  });

  it("matches an ASCII secret of equal length but only the exact bytes pass", () => {
    vi.stubEnv("CRON_SECRET", "abc-secret");
    expect(authorizeCronRequest(reqWith("abc-secret") as never)).toBe(true);
    expect(authorizeCronRequest(reqWith("abd-secret") as never)).toBe(false);
  });
});
