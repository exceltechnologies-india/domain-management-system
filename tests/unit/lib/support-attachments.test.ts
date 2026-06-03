/**
 * Tests for `@/lib/support-attachments` (rescan-4 slice 7fr). Image-
 * attachment validation for support tickets. Defence-in-depth pipeline.
 * Pins:
 *  - **Constants**: MAX_FILES=4, MAX_SIZE_BYTES=2MB, TOTAL_CAP=20MB,
 *    ALLOWED_MIMES = {jpeg,png,webp,gif} (NO svg — would allow embedded JS)
 *  - **Pipeline order** (rejection short-circuits): array-shape → count
 *    cap → per-item: filename → mime → mime-allowlist → size → size-cap
 *    → dataUrl → prefix → base64-charset → decode → decoded-size → magic
 *  - **Magic-byte verification** PNG/JPEG/GIF/WEBP — disguised content
 *    (HTML as fake-PNG) rejected with `magic_mismatch:` reason logged
 *  - **Strict base64 charset** — `+`, `/`, A–Za–z0–9 with optional `={0,2}`
 *    padding; everything else rejected
 *  - **Tight decoded-size tolerance** (4 bytes — was 10% before, narrowed
 *    to defeat smuggling)
 *  - **Filename sanitisation**: control chars stripped, path separators →
 *    `_`, HTML chars stripped, leading dots stripped, cap 100, empty-
 *    after-sanitise → `screenshot.<ext>` fallback
 *  - **Decoded size overrides client-declared size** in the CleanAttachment
 *    (client could lie; we trust the byte count we actually decoded)
 *  - **null / undefined / empty array → success with []** (no attachment
 *    is a valid state)
 *  - sumExistingAttachmentBytes + checkTicketTotalCap — 20MB cumulative
 *    cap helper
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  validateAttachments,
  sumExistingAttachmentBytes,
  checkTicketTotalCap,
  ATTACHMENT_MAX_FILES,
  ATTACHMENT_MAX_SIZE_BYTES,
  ATTACHMENT_TICKET_TOTAL_CAP,
  ATTACHMENT_ALLOWED_MIMES,
} from "@/lib/support-attachments";

// ── helpers ──────────────────────────────────────────────────────────
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff]);
const GIF87_SIG = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]);
const GIF89_SIG = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP_SIG = Buffer.from([
  0x52, 0x49, 0x46, 0x46, // RIFF
  0x00, 0x00, 0x00, 0x00, // size placeholder
  0x57, 0x45, 0x42, 0x50, // WEBP
]);

function makeAttachment(opts: {
  mimeType?: string;
  buffer?: Buffer;
  filename?: string;
  size?: number;
  dataUrlOverride?: string;
} = {}) {
  const mimeType = opts.mimeType ?? "image/png";
  const buffer = opts.buffer ?? PNG_SIG;
  const base64 = buffer.toString("base64");
  const dataUrl =
    opts.dataUrlOverride ?? `data:${mimeType};base64,${base64}`;
  return {
    filename: opts.filename ?? "shot.png",
    mimeType,
    size: opts.size ?? buffer.length,
    dataUrl,
  };
}

describe("constants", () => {
  it("limits: max files 4, max per-file 2MB, total cap 20MB", () => {
    expect(ATTACHMENT_MAX_FILES).toBe(4);
    expect(ATTACHMENT_MAX_SIZE_BYTES).toBe(2 * 1024 * 1024);
    expect(ATTACHMENT_TICKET_TOTAL_CAP).toBe(20 * 1024 * 1024);
  });

  it("allowlist: jpeg/png/webp/gif (NO svg — embedded JS risk)", () => {
    expect(ATTACHMENT_ALLOWED_MIMES.has("image/jpeg")).toBe(true);
    expect(ATTACHMENT_ALLOWED_MIMES.has("image/png")).toBe(true);
    expect(ATTACHMENT_ALLOWED_MIMES.has("image/webp")).toBe(true);
    expect(ATTACHMENT_ALLOWED_MIMES.has("image/gif")).toBe(true);
    expect(ATTACHMENT_ALLOWED_MIMES.has("image/svg+xml")).toBe(false);
    expect(ATTACHMENT_ALLOWED_MIMES.size).toBe(4);
  });
});

describe("validateAttachments — shape and short-circuits", () => {
  it("null → empty success (no attachment is valid)", () => {
    expect(validateAttachments(null)).toEqual({ ok: true, attachments: [] });
  });

  it("undefined → empty success", () => {
    expect(validateAttachments(undefined)).toEqual({
      ok: true,
      attachments: [],
    });
  });

  it("non-array → reject", () => {
    const r = validateAttachments({ filename: "x" });
    expect(r).toEqual({ ok: false, error: "Attachments must be an array" });
  });

  it("empty array → empty success", () => {
    expect(validateAttachments([])).toEqual({ ok: true, attachments: [] });
  });

  it("more than 4 files → reject", () => {
    const five = [
      makeAttachment(),
      makeAttachment(),
      makeAttachment(),
      makeAttachment(),
      makeAttachment(),
    ];
    const r = validateAttachments(five);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/at most 4 images/);
  });

  it("non-object entry → reject", () => {
    const r = validateAttachments(["nope"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("Invalid attachment entry");
  });
});

describe("validateAttachments — per-item field rejects", () => {
  it("missing filename → reject 'filename is required'", () => {
    const r = validateAttachments([{ ...makeAttachment(), filename: "" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/filename is required/);
  });

  it("missing mimeType → reject 'MIME type is required'", () => {
    const r = validateAttachments([{ ...makeAttachment(), mimeType: "" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/MIME type is required/);
  });

  it("disallowed MIME (svg) → reject", () => {
    const r = validateAttachments([
      makeAttachment({ mimeType: "image/svg+xml" }),
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.error).toMatch(/Only JPEG, PNG, WebP, and GIF images/);
  });

  it("size <= 0 → reject", () => {
    const r = validateAttachments([{ ...makeAttachment(), size: 0 }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Invalid attachment size/);
  });

  it("size NaN → reject", () => {
    const r = validateAttachments([{ ...makeAttachment(), size: NaN }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Invalid attachment size/);
  });

  it("size > 2MB → reject 'under 2 MB'", () => {
    const r = validateAttachments([
      { ...makeAttachment(), size: 2 * 1024 * 1024 + 1 },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/under 2 MB/);
  });

  it("missing dataUrl → reject 'data is required'", () => {
    const r = validateAttachments([{ ...makeAttachment(), dataUrl: "" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/data is required/);
  });
});

describe("validateAttachments — dataUrl prefix + base64 charset", () => {
  it("data URI MIME mismatch (declares png, prefix is jpeg) → reject", () => {
    const att = makeAttachment({
      dataUrlOverride: `data:image/jpeg;base64,${PNG_SIG.toString("base64")}`,
    });
    const r = validateAttachments([att]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/matching MIME type/);
  });

  it("invalid base64 charset (contains '@') → reject", () => {
    const att = makeAttachment({
      dataUrlOverride: `data:image/png;base64,@@@@invalid@@@`,
    });
    const r = validateAttachments([att]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not valid base64/);
  });

  it("empty base64 payload → reject", () => {
    const att = makeAttachment({
      dataUrlOverride: `data:image/png;base64,`,
    });
    const r = validateAttachments([att]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not valid base64/);
  });
});

describe("validateAttachments — decoded size tolerance", () => {
  it("declared-vs-decoded mismatch >4 bytes → reject", () => {
    const att = makeAttachment({ size: PNG_SIG.length + 100 });
    const r = validateAttachments([att]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/size mismatch/);
  });

  it("declared-vs-decoded within 4 bytes (base64 padding) → accepted", () => {
    const att = makeAttachment({ size: PNG_SIG.length + 2 });
    const r = validateAttachments([att]);
    expect(r.ok).toBe(true);
  });
});

describe("validateAttachments — magic-byte verification", () => {
  it("declared PNG but payload is HTML → magic_mismatch reject", () => {
    const fake = Buffer.from("<html>nope</html>");
    const att = makeAttachment({ buffer: fake });
    const r = validateAttachments([att]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/doesn't match its declared image type/);
  });

  it("valid PNG signature → accepted", () => {
    const r = validateAttachments([makeAttachment()]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.attachments[0].mimeType).toBe("image/png");
      expect(r.attachments[0].size).toBe(PNG_SIG.length); // decoded size wins
    }
  });

  it("valid JPEG signature → accepted", () => {
    const r = validateAttachments([
      makeAttachment({ mimeType: "image/jpeg", buffer: JPEG_SIG }),
    ]);
    expect(r.ok).toBe(true);
  });

  it("valid GIF87 signature → accepted", () => {
    const r = validateAttachments([
      makeAttachment({ mimeType: "image/gif", buffer: GIF87_SIG }),
    ]);
    expect(r.ok).toBe(true);
  });

  it("valid GIF89 signature → accepted (87a OR 89a)", () => {
    const r = validateAttachments([
      makeAttachment({ mimeType: "image/gif", buffer: GIF89_SIG }),
    ]);
    expect(r.ok).toBe(true);
  });

  it("valid WEBP RIFF/WEBP signature → accepted", () => {
    const r = validateAttachments([
      makeAttachment({ mimeType: "image/webp", buffer: WEBP_SIG }),
    ]);
    expect(r.ok).toBe(true);
  });

  it("PNG declared with first byte flipped → magic mismatch reject", () => {
    const corrupted = Buffer.from(PNG_SIG);
    corrupted[0] = 0x00; // break the signature
    const r = validateAttachments([makeAttachment({ buffer: corrupted })]);
    expect(r.ok).toBe(false);
  });

  it("WEBP without the 'WEBP' bytes → magic mismatch reject", () => {
    const corrupted = Buffer.from(WEBP_SIG);
    corrupted[8] = 0x00; // break 'W'
    const r = validateAttachments([
      makeAttachment({ mimeType: "image/webp", buffer: corrupted }),
    ]);
    expect(r.ok).toBe(false);
  });
});

describe("validateAttachments — filename sanitisation in CleanAttachment", () => {
  function clean(filename: string, mime = "image/png", buf = PNG_SIG): string | null {
    const r = validateAttachments([
      makeAttachment({ filename, mimeType: mime, buffer: buf }),
    ]);
    if (!r.ok) return null;
    return r.attachments[0].filename;
  }

  it("path separators → underscores", () => {
    expect(clean("a/b/c.png")).toBe("a_b_c.png");
    expect(clean("a\\b\\c.png")).toBe("a_b_c.png");
  });

  it("control chars stripped", () => {
    expect(clean("a\x00\x01\x7fb.png")).toBe("ab.png");
  });

  it("HTML metacharacters stripped", () => {
    expect(clean('<script>"\'`x.png')).toBe("scriptx.png");
  });

  it("leading dots stripped (no hidden files)", () => {
    expect(clean("..hidden.png")).toBe("hidden.png");
  });

  it("length capped at 100", () => {
    const f = clean("a".repeat(200) + ".png");
    expect(f?.length).toBe(100);
  });

  it("empty after sanitisation → screenshot.<ext> fallback (png)", () => {
    expect(clean("....")).toBe("screenshot.png");
  });

  it("empty after sanitisation → screenshot.jpg for image/jpeg", () => {
    expect(clean("....", "image/jpeg", JPEG_SIG)).toBe("screenshot.jpg");
  });

  it("empty after sanitisation → screenshot.gif for image/gif", () => {
    expect(clean("....", "image/gif", GIF87_SIG)).toBe("screenshot.gif");
  });

  it("empty after sanitisation → screenshot.webp for image/webp", () => {
    expect(clean("....", "image/webp", WEBP_SIG)).toBe("screenshot.webp");
  });
});

describe("validateAttachments — CleanAttachment shape", () => {
  it("returns mimeType + dataUrl verbatim + decoded size (NOT client-declared)", () => {
    const r = validateAttachments([
      makeAttachment({
        filename: "ok.png",
        // Declared size LIES — 4 bytes high but tolerated
        size: PNG_SIG.length + 2,
      }),
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.attachments[0]).toEqual({
        filename: "ok.png",
        mimeType: "image/png",
        size: PNG_SIG.length, // **decoded size wins, NOT 10 (declared)**
        dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
      });
    }
  });
});

describe("sumExistingAttachmentBytes", () => {
  it("empty messages → 0", () => {
    expect(sumExistingAttachmentBytes([])).toBe(0);
  });

  it("messages with null / missing attachments → 0", () => {
    expect(
      sumExistingAttachmentBytes([null, undefined, {}, { attachments: undefined }])
    ).toBe(0);
  });

  it("sums valid sizes across messages and attachments", () => {
    expect(
      sumExistingAttachmentBytes([
        { attachments: [{ size: 100 }, { size: 200 }] },
        { attachments: [{ size: 50 }] },
      ])
    ).toBe(350);
  });

  it("skips non-numeric sizes and zero/negative", () => {
    expect(
      sumExistingAttachmentBytes([
        {
          attachments: [
            { size: 100 },
            { size: 0 }, // skipped
            { size: -50 }, // skipped (size > 0 gate)
            { size: "200" as unknown as number }, // skipped
            { size: NaN }, // skipped (NaN > 0 is false anyway but type-check catches)
          ],
        },
      ])
    ).toBe(100);
  });
});

describe("checkTicketTotalCap", () => {
  it("under 20MB cumulative → null (allowed)", () => {
    expect(
      checkTicketTotalCap(10 * 1024 * 1024, [
        { filename: "a", mimeType: "image/png", size: 1000, dataUrl: "" },
      ])
    ).toBeNull();
  });

  it("over 20MB → returns error string", () => {
    const r = checkTicketTotalCap(20 * 1024 * 1024 - 100, [
      { filename: "a", mimeType: "image/png", size: 200, dataUrl: "" },
      { filename: "b", mimeType: "image/png", size: 200, dataUrl: "" },
    ]);
    expect(r).toMatch(/storage limit \(20 MB\)/);
  });

  it("exactly at 20MB boundary → null (boundary inclusive)", () => {
    expect(
      checkTicketTotalCap(20 * 1024 * 1024 - 10, [
        { filename: "a", mimeType: "image/png", size: 10, dataUrl: "" },
      ])
    ).toBeNull();
  });

  it("exactly one byte over boundary → reject", () => {
    expect(
      checkTicketTotalCap(20 * 1024 * 1024, [
        { filename: "a", mimeType: "image/png", size: 1, dataUrl: "" },
      ])
    ).not.toBeNull();
  });

  it("empty newAttachments → null (no addition, nothing to enforce)", () => {
    expect(checkTicketTotalCap(20 * 1024 * 1024, [])).toBeNull();
  });
});
