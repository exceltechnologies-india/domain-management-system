/**
 * Tests for `@/lib/field-encryption` (rescan-4 slice 7dj).
 * Transparent AES-256-GCM field encryption for sensitive DB fields.
 * Pins:
 *  - Round-trip: encrypt → decrypt returns the original plaintext
 *  - Encrypted output starts with the 'enc:' prefix
 *  - Encrypting an already-encrypted value is a no-op
 *  - Decrypting a plaintext (legacy) value returns it verbatim
 *  - Empty string passes through both encrypt + decrypt
 *  - getKey requires a 64-char hex string (throws otherwise)
 *  - isEncrypted detects the prefix
 *  - Tampered ciphertext (wrong authTag) fails decryption
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const VALID_KEY = "a".repeat(64); // 32 bytes hex

beforeEach(() => {
  vi.stubEnv("FIELD_ENCRYPTION_KEY", VALID_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("encryptField / decryptField round-trip", () => {
  it("encrypt → decrypt returns the original plaintext", async () => {
    const { encryptField, decryptField } = await import("@/lib/field-encryption");
    const original = "27AAAAA0000A1Z5"; // GST-shaped string
    const encrypted = encryptField(original);
    expect(encrypted).not.toBe(original);
    expect(decryptField(encrypted)).toBe(original);
  });

  it("encrypted output starts with the 'enc:' prefix and is iv:tag:ciphertext", async () => {
    const { encryptField } = await import("@/lib/field-encryption");
    const out = encryptField("hello world");
    expect(out.startsWith("enc:")).toBe(true);
    const payload = out.slice(4);
    const parts = payload.split(":");
    expect(parts).toHaveLength(3);
    // IV = 12 bytes = 24 hex chars; auth tag = 16 bytes = 32 hex chars.
    expect(parts[0]).toHaveLength(24);
    expect(parts[1]).toHaveLength(32);
    expect(parts[2].length).toBeGreaterThan(0);
  });

  it("two encryptions of the same plaintext produce different ciphertexts (fresh IV)", async () => {
    const { encryptField } = await import("@/lib/field-encryption");
    const a = encryptField("repeat-me");
    const b = encryptField("repeat-me");
    expect(a).not.toBe(b);
  });

  it("re-encrypting an already-encrypted value is a no-op", async () => {
    const { encryptField } = await import("@/lib/field-encryption");
    const once = encryptField("data");
    const twice = encryptField(once);
    expect(twice).toBe(once);
  });

  it("decrypting a plaintext (legacy, no 'enc:' prefix) returns it verbatim", async () => {
    const { decryptField } = await import("@/lib/field-encryption");
    expect(decryptField("legacy-plaintext")).toBe("legacy-plaintext");
  });

  it("empty string passes through unchanged for both encrypt + decrypt", async () => {
    const { encryptField, decryptField } = await import("@/lib/field-encryption");
    expect(encryptField("")).toBe("");
    expect(decryptField("")).toBe("");
  });
});

describe("encryption key validation", () => {
  it("throws when FIELD_ENCRYPTION_KEY is too short", async () => {
    vi.stubEnv("FIELD_ENCRYPTION_KEY", "short-key");
    const { encryptField } = await import("@/lib/field-encryption");
    expect(() => encryptField("anything")).toThrow(/64-character hex string/);
  });

  it("throws when FIELD_ENCRYPTION_KEY is missing entirely", async () => {
    vi.stubEnv("FIELD_ENCRYPTION_KEY", "");
    const { encryptField } = await import("@/lib/field-encryption");
    expect(() => encryptField("anything")).toThrow(/64-character hex string/);
  });
});

describe("isEncrypted", () => {
  it("returns true for strings with the 'enc:' prefix", async () => {
    const { isEncrypted, encryptField } = await import("@/lib/field-encryption");
    const out = encryptField("hi");
    expect(isEncrypted(out)).toBe(true);
  });

  it("returns false for plain strings, undefined, and empty strings", async () => {
    const { isEncrypted } = await import("@/lib/field-encryption");
    expect(isEncrypted("plain")).toBe(false);
    expect(isEncrypted(undefined)).toBe(false);
    expect(isEncrypted("")).toBe(false);
  });
});

describe("ciphertext tampering", () => {
  it("decryption throws when the auth tag has been tampered", async () => {
    const { encryptField, decryptField } = await import("@/lib/field-encryption");
    const ct = encryptField("sensitive");
    // Flip the last hex char of the auth tag.
    const parts = ct.slice(4).split(":");
    const flipped = parts[1].slice(0, -1) + (parts[1].slice(-1) === "0" ? "1" : "0");
    const tampered = `enc:${parts[0]}:${flipped}:${parts[2]}`;
    expect(() => decryptField(tampered)).toThrow();
  });

  it("decryption throws on a malformed 'enc:' payload (missing parts)", async () => {
    const { decryptField } = await import("@/lib/field-encryption");
    expect(() => decryptField("enc:not-enough-parts")).toThrow(
      /Invalid encrypted field format/
    );
  });
});
