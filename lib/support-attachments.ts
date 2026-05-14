/**
 * Validation helper for support-ticket image attachments.
 *
 * Storage approach: base64-encoded data URIs inline on the message document.
 * Suitable for small, low-volume use cases (screenshots in support tickets).
 *
 * Defence-in-depth measures here:
 *  1. Allowlist of MIME types (no SVG — would allow embedded JS).
 *  2. Magic-byte verification — the decoded bytes must actually be the format
 *     they claim to be. A user can't lie about MIME type to upload arbitrary
 *     content.
 *  3. Strict base64 charset check + tight size tolerance — rejects malformed
 *     or oversized payloads early.
 *  4. Filename sanitisation — strips control chars, path separators, and HTML
 *     so the name can't be weaponised in the UI, email, or browser save dialog.
 *  5. Per-message count + size caps (matches server-enforced limits below).
 *  6. Per-ticket cumulative size cap helper for the reply path so storage
 *     can't be inflated by many small replies.
 */

import { serverLogger } from "@/lib/server-logger";

export const ATTACHMENT_MAX_FILES = 4;
export const ATTACHMENT_MAX_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB per file
export const ATTACHMENT_TICKET_TOTAL_CAP = 20 * 1024 * 1024; // 20 MB cumulative across a ticket
export const ATTACHMENT_ALLOWED_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

/** Strict base64 charset (with optional `=` padding). */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Magic-byte signatures for each allowed MIME. */
const MAGIC_SIGNATURES: Record<string, (buf: Buffer) => boolean> = {
  "image/png": (b) =>
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  "image/jpeg": (b) =>
    b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/gif": (b) =>
    b.length >= 6 &&
    b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && // "GIF"
    b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61, // "87a" or "89a"
  "image/webp": (b) =>
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // "RIFF"
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50, // "WEBP"
};

export interface RawAttachment {
  filename?: string;
  mimeType?: string;
  size?: number;
  dataUrl?: string;
}

export interface CleanAttachment {
  filename: string;
  mimeType: string;
  size: number;
  dataUrl: string;
}

/**
 * Sanitise a user-supplied filename so it's safe to render and download.
 * - Strip control / null / path-separator chars
 * - Strip leading dots (hidden files)
 * - Strip HTML metacharacters
 * - Cap length, fall back to "image.<ext>" if empty after sanitisation
 */
function sanitiseFilename(raw: string, mimeType: string): string {
  let s = raw
    .replace(/[\x00-\x1f\x7f]/g, "") // control chars + NUL
    .replace(/[\\/]/g, "_")          // path separators
    .replace(/[<>"'`]/g, "")         // HTML/quote chars
    .replace(/^\.+/, "")             // leading dots
    .trim();
  if (s.length > 100) s = s.slice(0, 100);
  if (!s) {
    const ext =
      mimeType === "image/jpeg" ? "jpg" :
      mimeType === "image/png"  ? "png" :
      mimeType === "image/webp" ? "webp" :
      mimeType === "image/gif"  ? "gif" : "img";
    s = `screenshot.${ext}`;
  }
  return s;
}

/**
 * Validate + sanitize an attachment array from the client.
 * Returns either { ok: true, attachments } or { ok: false, error }.
 *
 * Performs hard validation: magic-byte verification, strict base64 charset,
 * tight size matching, MIME-allowlist, and filename sanitisation. Logs each
 * rejection so probes are visible in server logs.
 */
export function validateAttachments(
  raw: unknown,
  context?: { userId?: string; route?: string }
): { ok: true; attachments: CleanAttachment[] } | { ok: false; error: string } {
  const reject = (error: string, reason: string): { ok: false; error: string } => {
    serverLogger.warn("[support-attachments] rejected", {
      reason,
      userId: context?.userId,
      route: context?.route,
    });
    return { ok: false, error };
  };

  if (raw === undefined || raw === null) return { ok: true, attachments: [] };
  if (!Array.isArray(raw)) return reject("Attachments must be an array", "not_array");
  if (raw.length === 0) return { ok: true, attachments: [] };
  if (raw.length > ATTACHMENT_MAX_FILES) {
    return reject(
      `You can attach at most ${ATTACHMENT_MAX_FILES} images`,
      `count_${raw.length}`
    );
  }

  const clean: CleanAttachment[] = [];
  for (const item of raw as RawAttachment[]) {
    if (!item || typeof item !== "object") {
      return reject("Invalid attachment entry", "not_object");
    }
    const { filename, mimeType, size, dataUrl } = item;

    if (!filename || typeof filename !== "string") {
      return reject("Attachment filename is required", "filename_missing");
    }
    if (!mimeType || typeof mimeType !== "string") {
      return reject("Attachment MIME type is required", "mime_missing");
    }
    if (!ATTACHMENT_ALLOWED_MIMES.has(mimeType)) {
      return reject(
        "Only JPEG, PNG, WebP, and GIF images are allowed",
        `mime_disallowed:${mimeType.slice(0, 40)}`
      );
    }
    if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
      return reject("Invalid attachment size", "size_invalid");
    }
    if (size > ATTACHMENT_MAX_SIZE_BYTES) {
      return reject(
        `Each image must be under ${Math.round(ATTACHMENT_MAX_SIZE_BYTES / 1024 / 1024)} MB`,
        `size_over:${size}`
      );
    }
    if (!dataUrl || typeof dataUrl !== "string") {
      return reject("Attachment data is required", "dataurl_missing");
    }

    // Strict data URI prefix — declared MIME must match the data URI MIME.
    const expectedPrefix = `data:${mimeType};base64,`;
    if (!dataUrl.startsWith(expectedPrefix)) {
      return reject(
        "Attachment data must be base64-encoded with matching MIME type",
        "dataurl_prefix_mismatch"
      );
    }

    // Strict base64 charset.
    const base64 = dataUrl.slice(expectedPrefix.length);
    if (base64.length === 0 || !BASE64_RE.test(base64)) {
      return reject("Attachment payload is not valid base64", "base64_charset");
    }

    // Decode and verify size + magic bytes.
    let buffer: Buffer;
    try {
      buffer = Buffer.from(base64, "base64");
    } catch {
      return reject("Failed to decode attachment payload", "decode_failed");
    }
    if (buffer.length === 0) {
      return reject("Attachment payload is empty", "empty_buffer");
    }
    if (buffer.length > ATTACHMENT_MAX_SIZE_BYTES) {
      return reject(
        `Each image must be under ${Math.round(ATTACHMENT_MAX_SIZE_BYTES / 1024 / 1024)} MB`,
        `decoded_size_over:${buffer.length}`
      );
    }
    // Tight tolerance: client-declared size must match decoded length within
    // base64 rounding (up to ~3 bytes), not the loose 10 % we had before.
    if (Math.abs(buffer.length - size) > 4) {
      return reject(
        "Attachment size mismatch — please re-pick the file",
        `size_mismatch:declared=${size},decoded=${buffer.length}`
      );
    }

    // Magic-byte verification. Declared MIME must actually be the file's
    // format. Prevents disguised content (HTML/JS/binary as fake image).
    const verify = MAGIC_SIGNATURES[mimeType];
    if (!verify || !verify(buffer)) {
      return reject(
        "Attachment doesn't match its declared image type",
        `magic_mismatch:${mimeType}`
      );
    }

    clean.push({
      filename: sanitiseFilename(filename, mimeType),
      mimeType,
      size: buffer.length, // use verified decoded size, not client-claimed
      dataUrl,
    });
  }
  return { ok: true, attachments: clean };
}

/**
 * Compute the total bytes already used by attachments on a ticket.
 * Used in the reply path to enforce ATTACHMENT_TICKET_TOTAL_CAP.
 */
export function sumExistingAttachmentBytes(
  messages: Array<{ attachments?: Array<{ size?: number }> } | null | undefined>
): number {
  let total = 0;
  for (const m of messages) {
    if (!m?.attachments) continue;
    for (const a of m.attachments) {
      if (typeof a?.size === "number" && a.size > 0) total += a.size;
    }
  }
  return total;
}

/**
 * Enforce per-ticket cumulative cap. Returns an error string if exceeded,
 * or null if the addition is allowed.
 */
export function checkTicketTotalCap(
  existingBytes: number,
  newAttachments: CleanAttachment[]
): string | null {
  const addBytes = newAttachments.reduce((s, a) => s + a.size, 0);
  if (existingBytes + addBytes > ATTACHMENT_TICKET_TOTAL_CAP) {
    return `This ticket has reached its attachment storage limit (${Math.round(
      ATTACHMENT_TICKET_TOTAL_CAP / 1024 / 1024
    )} MB). Please open a new ticket or remove some attachments.`;
  }
  return null;
}
