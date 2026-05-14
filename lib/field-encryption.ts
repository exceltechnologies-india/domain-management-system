/**
 * AES-256-GCM transparent field encryption for sensitive DB fields (GST numbers, etc.)
 *
 * Key lifecycle:
 *   - FIELD_ENCRYPTION_KEY env var must be a 32-byte hex string (64 hex chars).
 *   - Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *   - Rotate by re-encrypting all documents and changing the key.
 *
 * Encrypted format: "<iv_hex>:<authTag_hex>:<ciphertext_hex>"
 * Prefix "enc:" is prepended so plaintext values can be detected and migrated.
 */

import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ENCRYPTED_PREFIX = "enc:";

function getKey(): Buffer {
  const raw = process.env.FIELD_ENCRYPTION_KEY;
  if (!raw || raw.length !== 64) {
    throw new Error(
      "FIELD_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). " +
        "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  return Buffer.from(raw, "hex");
}

export function encryptField(plaintext: string): string {
  if (!plaintext) return plaintext;
  if (plaintext.startsWith(ENCRYPTED_PREFIX)) return plaintext; // already encrypted

  const key = getKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv) as crypto.CipherGCM;
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${ENCRYPTED_PREFIX}${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptField(ciphertext: string): string {
  if (!ciphertext) return ciphertext;
  if (!ciphertext.startsWith(ENCRYPTED_PREFIX)) {
    // Plaintext legacy value — return as-is; will be encrypted on next save
    return ciphertext;
  }

  const key = getKey();
  const payload = ciphertext.slice(ENCRYPTED_PREFIX.length);
  const [ivHex, tagHex, dataHex] = payload.split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("Invalid encrypted field format");

  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const data = Buffer.from(dataHex, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv) as crypto.DecipherGCM;
  decipher.setAuthTag(tag);
  return decipher.update(data) + decipher.final("utf8");
}

export function isEncrypted(value: string | undefined): boolean {
  return typeof value === "string" && value.startsWith(ENCRYPTED_PREFIX);
}
