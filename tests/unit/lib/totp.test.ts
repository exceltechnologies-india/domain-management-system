/**
 * Unit tests for the TOTP primitives in lib/totp.ts.
 *
 * The auth flow's 2FA branch in lib/auth-config/providers.ts depends on these
 * primitives correctly verifying live codes + backup codes. This suite locks
 * in their behaviour so a regression (e.g. the otplib API change that
 * landed during the 13th typing pass, when `options.window` got renamed to
 * `epochTolerance`) gets caught here, not at login time.
 *
 * Targets:
 *   - generateTotpSecret() — non-empty, base32-shaped
 *   - verifyTotpCode() — accepts a code derived from the same secret;
 *     rejects code from a different secret; rejects malformed input;
 *     tolerates whitespace; tolerates ±30s clock skew (the SKEW_TOLERANCE_S
 *     setting); never throws on garbage input (returns false instead)
 *   - getTotpUri() — otpauth:// URI shape, correct issuer + label
 *   - generateBackupCodes() — count, uniqueness, format
 *   - hashBackupCode / verifyBackupCode — case + dash tolerance, mismatch
 *     rejection, never throws on bad hash
 */
import { describe, it, expect } from "vitest";
import { generateSync as otpGenerateSync } from "otplib";
import {
  generateTotpSecret,
  verifyTotpCode,
  getTotpUri,
  generateBackupCodes,
  hashBackupCode,
  verifyBackupCode,
} from "@/lib/totp";

// ── Secret + code generation ────────────────────────────────────────────────

describe("generateTotpSecret", () => {
  it("returns a non-empty base32-shaped string", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/i);
    expect(secret.length).toBeGreaterThanOrEqual(16);
  });

  it("generates a different secret on each call (no shared state)", () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).not.toBe(b);
  });
});

// ── verifyTotpCode ──────────────────────────────────────────────────────────

describe("verifyTotpCode", () => {
  it("accepts a current code derived from the same secret", () => {
    const secret = generateTotpSecret();
    const code = otpGenerateSync({ secret });
    expect(verifyTotpCode(secret, code)).toBe(true);
  });

  it("rejects a code derived from a different secret", () => {
    const secretA = generateTotpSecret();
    const secretB = generateTotpSecret();
    const codeForA = otpGenerateSync({ secret: secretA });
    expect(verifyTotpCode(secretB, codeForA)).toBe(false);
  });

  it("tolerates whitespace inside the code (some auth apps render with spaces)", () => {
    const secret = generateTotpSecret();
    const code = otpGenerateSync({ secret });
    // Inject a space mid-code — strip-whitespace path must still verify.
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyTotpCode(secret, spaced)).toBe(true);
  });

  it("rejects empty string", () => {
    const secret = generateTotpSecret();
    expect(verifyTotpCode(secret, "")).toBe(false);
  });

  it("rejects non-numeric input without throwing", () => {
    const secret = generateTotpSecret();
    expect(verifyTotpCode(secret, "abcdef")).toBe(false);
  });

  it("rejects 5-digit codes (too short)", () => {
    const secret = generateTotpSecret();
    expect(verifyTotpCode(secret, "12345")).toBe(false);
  });

  it("never throws on garbage secret input — returns false", () => {
    // The catch-block in verifyTotpCode swallows otplib parse errors so a
    // malformed secret stored on disk doesn't break login.
    expect(verifyTotpCode("not-a-real-secret!!!", "123456")).toBe(false);
  });

  it("tolerates ±30s clock skew (epochTolerance: 30)", () => {
    // Generate a code "30s ago" and "30s in the future" — both should
    // verify since the tolerance is one step. The otplib `epoch` option
    // lets us drive deterministic skew without messing with Date.
    const secret = generateTotpSecret();
    const now = Math.floor(Date.now() / 1000);
    const codePast = otpGenerateSync({ secret, epoch: now - 30 });
    const codeFuture = otpGenerateSync({ secret, epoch: now + 30 });

    expect(verifyTotpCode(secret, codePast)).toBe(true);
    expect(verifyTotpCode(secret, codeFuture)).toBe(true);
  });

  it("rejects codes outside the tolerance window (~120s old)", () => {
    // Anything older than ~one extra step should be rejected. Use 120s
    // (~4 steps) to put it firmly outside the ±30s tolerance.
    const secret = generateTotpSecret();
    const now = Math.floor(Date.now() / 1000);
    const oldCode = otpGenerateSync({ secret, epoch: now - 120 });
    expect(verifyTotpCode(secret, oldCode)).toBe(false);
  });
});

// ── getTotpUri ──────────────────────────────────────────────────────────────

describe("getTotpUri", () => {
  it("returns an otpauth:// URI with the configured issuer + provided label", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const uri = getTotpUri(secret, "user@example.com");
    expect(uri.startsWith("otpauth://")).toBe(true);
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    // Label is URL-encoded — match both the encoded and decoded form
    // depending on otplib's output style.
    expect(uri).toMatch(/user(@|%40)example\.com/);
    expect(uri).toMatch(/issuer=[A-Za-z]+/);
  });
});

// ── Backup-code generation ──────────────────────────────────────────────────

describe("generateBackupCodes", () => {
  it("returns 8 codes by default", () => {
    expect(generateBackupCodes()).toHaveLength(8);
  });

  it("honours the count argument", () => {
    expect(generateBackupCodes(3)).toHaveLength(3);
    expect(generateBackupCodes(12)).toHaveLength(12);
  });

  it("formats each code as XXXXX-XXXXX (10 hex chars, dash-separated)", () => {
    const codes = generateBackupCodes(8);
    for (const code of codes) {
      expect(code).toMatch(/^[0-9A-F]{5}-[0-9A-F]{5}$/);
    }
  });

  it("generates unique codes within a single batch (no collisions on small sets)", () => {
    // SECURITY: duplicate codes mean re-use across two pages of the
    // generated list — only matters if generation is broken.
    const codes = generateBackupCodes(16);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

// ── hashBackupCode + verifyBackupCode ───────────────────────────────────────

describe("hashBackupCode / verifyBackupCode", () => {
  it("verifyBackupCode accepts the exact same string that was hashed", async () => {
    const code = "ABCDE-12345";
    const hash = await hashBackupCode(code);
    expect(await verifyBackupCode(code, hash)).toBe(true);
  });

  it("tolerates lowercase input (normalises to upper before compare)", async () => {
    const code = "ABCDE-12345";
    const hash = await hashBackupCode(code);
    expect(await verifyBackupCode("abcde-12345", hash)).toBe(true);
  });

  it("tolerates missing dash (some users type the code without it)", async () => {
    const code = "ABCDE-12345";
    const hash = await hashBackupCode(code);
    expect(await verifyBackupCode("ABCDE12345", hash)).toBe(true);
  });

  it("rejects a different code with the same length", async () => {
    const hash = await hashBackupCode("ABCDE-12345");
    expect(await verifyBackupCode("FFFFF-99999", hash)).toBe(false);
  });

  it("rejects empty input against a real hash", async () => {
    const hash = await hashBackupCode("ABCDE-12345");
    expect(await verifyBackupCode("", hash)).toBe(false);
  });

  it("returns false on a malformed hash (never throws — providers.ts loops over hashes)", async () => {
    // SECURITY-CRITICAL: providers.ts iterates the user's
    // totpBackupCodes array looking for a match. If verifyBackupCode
    // throws on one entry, it would skip all remaining valid codes.
    // bcrypt.compare(plain, malformedHash) returns false rather than
    // throwing — fence that here so future bcrypt updates don't change it.
    expect(await verifyBackupCode("ABCDE-12345", "not-a-bcrypt-hash")).toBe(false);
  });
});
