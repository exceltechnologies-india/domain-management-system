/**
 * Lightweight device fingerprint generated client-side. Not as strong as
 * FingerprintJS, but free, dependency-less, and good enough for the
 * "same browser, fresh email" abuse case on the hosting trial flow.
 *
 * Stable signals:
 *   - userAgent
 *   - language
 *   - timezone
 *   - screen w/h + color depth
 *   - hardwareConcurrency
 *   - deviceMemory (where available)
 *   - canvas paint hash (renders a tiny string, captures GPU + font quirks)
 *
 * SHA-256-hashed in the browser via SubtleCrypto so the raw fingerprint
 * never leaves the device and isn't network-observable.
 */

function canvasHashSync(): string {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 50;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    ctx.textBaseline = "top";
    ctx.font = "14px 'Arial'";
    ctx.fillStyle = "#f60";
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = "#069";
    ctx.fillText("device-fp-anutech-✦", 2, 15);
    ctx.fillStyle = "rgba(102, 204, 0, 0.7)";
    ctx.fillText("device-fp-anutech-✦", 4, 17);
    return canvas.toDataURL();
  } catch {
    return "";
  }
}

async function sha256(input: string): Promise<string> {
  try {
    const enc = new TextEncoder().encode(input);
    const buf = await crypto.subtle.digest("SHA-256", enc);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    // Fallback: cheap non-cryptographic hash. Still stable per device.
    let h = 0;
    for (let i = 0; i < input.length; i++) {
      h = ((h << 5) - h + input.charCodeAt(i)) | 0;
    }
    return `fb_${Math.abs(h).toString(16)}`;
  }
}

let cached: string | null = null;

/**
 * Returns a stable hex hash representing this device. Caches the result
 * per page-load so repeated calls don't re-paint the canvas.
 */
export async function getDeviceFingerprint(): Promise<string> {
  if (typeof window === "undefined") return "";
  if (cached) return cached;

  const tz =
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    new Date().getTimezoneOffset().toString();

  const parts = [
    navigator.userAgent,
    navigator.language,
    tz,
    `${screen.width}x${screen.height}x${screen.colorDepth}`,
    String(navigator.hardwareConcurrency || ""),
    // `deviceMemory` is part of the Device Memory API draft spec — not in
    // the standard Navigator type yet, so we read it via a structural cast.
    String((navigator as Navigator & { deviceMemory?: number }).deviceMemory || ""),
    canvasHashSync(),
  ];

  cached = await sha256(parts.join("|"));
  return cached;
}
