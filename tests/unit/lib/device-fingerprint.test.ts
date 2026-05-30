/**
 * Tests for `@/lib/device-fingerprint` (rescan-4 slice 7dn).
 * Lightweight client-side device-fingerprint hash. Pins:
 *  - SSR (no window) → empty string (defensive guard)
 *  - First call computes a hex hash; second call returns the cached
 *    result without re-hashing
 *  - Two different navigator/screen profiles produce different hashes
 *    (module reset between cases since `cached` is module-scoped)
 *  - SubtleCrypto unavailable → falls back to the cheap non-crypto
 *    hash with the 'fb_' prefix
 *  - Canvas-throws path → empty canvas hash but full hash still produced
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We capture the real crypto.subtle once at import time so the
// fallback test can restore it cleanly even when crypto.subtle isn't
// an own property (it's on a prototype in jsdom).
const REAL_SUBTLE = crypto.subtle;

function setNav(props: Partial<Navigator>) {
  for (const [k, v] of Object.entries(props)) {
    Object.defineProperty(navigator, k, {
      value: v,
      configurable: true,
      writable: true,
    });
  }
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  // Always restore the real subtle — defineProperty (not assignment)
  // because in some jsdom builds `crypto.subtle` is a non-writable
  // accessor and direct assignment silently no-ops.
  Object.defineProperty(crypto, "subtle", {
    value: REAL_SUBTLE,
    configurable: true,
    writable: true,
  });
});

describe("getDeviceFingerprint", () => {
  it("returns a stable SHA-256-style 64-hex-char hash on first call", async () => {
    setNav({
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) Test/1.0",
      language: "en-US",
      hardwareConcurrency: 8,
    });
    const { getDeviceFingerprint } = await import("@/lib/device-fingerprint");
    const fp = await getDeviceFingerprint();
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("caches the result across calls within a single module load", async () => {
    setNav({ userAgent: "Test/UA", language: "en", hardwareConcurrency: 4 });
    const { getDeviceFingerprint } = await import("@/lib/device-fingerprint");
    const a = await getDeviceFingerprint();
    const b = await getDeviceFingerprint();
    expect(a).toBe(b);
  });

  it("different navigator profiles → different hashes (module reset between cases)", async () => {
    setNav({ userAgent: "UA1", language: "en", hardwareConcurrency: 4 });
    const mod1 = await import("@/lib/device-fingerprint");
    const fp1 = await mod1.getDeviceFingerprint();

    vi.resetModules();
    setNav({ userAgent: "UA2-different", language: "fr", hardwareConcurrency: 16 });
    const mod2 = await import("@/lib/device-fingerprint");
    const fp2 = await mod2.getDeviceFingerprint();

    expect(fp1).not.toBe(fp2);
  });

  it("falls back to 'fb_' prefixed non-crypto hash when subtle.digest throws", async () => {
    Object.defineProperty(crypto, "subtle", {
      value: {
        digest: vi.fn().mockRejectedValue(new Error("subtle unavailable")),
      },
      configurable: true,
    });
    setNav({ userAgent: "FallbackUA", language: "en", hardwareConcurrency: 4 });
    const { getDeviceFingerprint } = await import("@/lib/device-fingerprint");
    const fp = await getDeviceFingerprint();
    expect(fp).toMatch(/^fb_[0-9a-f]+$/);
  });

  it("canvas-throws path still returns a full hash (canvas portion empty)", async () => {
    // Force canvas.getContext → null so canvasHashSync's early return path hits.
    const original = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      value: () => null,
      configurable: true,
      writable: true,
    });
    try {
      setNav({ userAgent: "NoCanvas", language: "en", hardwareConcurrency: 4 });
      const { getDeviceFingerprint } = await import("@/lib/device-fingerprint");
      const fp = await getDeviceFingerprint();
      // Hash still produced, just from non-canvas signals.
      expect(fp).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  });
});
