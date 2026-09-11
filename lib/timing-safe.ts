/**
 * Timing-safe comparison for secrets that arrive in a request.
 *
 * ─── WHY THIS IS A SHARED HELPER AND NOT A LOCAL ONE ────────────────────────
 * Written 2026-09-11, during a review of what this repository exposes by being
 * PUBLIC. Three places compare an HMAC that an unauthenticated caller supplies,
 * and they did it three different ways:
 *
 *   app/api/webhooks/whatsapp/route.ts   crypto.timingSafeEqual  ✓
 *   app/razorpay/webhook/route.ts        generated !== signature ✗
 *   lib/razorpay.ts verifyWebhookSignature  expected === signature ✗
 *
 * One correct implementation and two that were not is the argument for having
 * exactly one, in one file, that every caller imports.
 *
 * ─── WHAT `===` ACTUALLY COSTS ──────────────────────────────────────────────
 * A string comparison returns as soon as two bytes differ, so how long it takes
 * depends on how much of the prefix was right. Measured over a network that
 * difference is nanoseconds against milliseconds of jitter, so this is NOT a
 * practical break of either Razorpay webhook today, and it should not be
 * described as one.
 *
 * It is fixed anyway for two reasons. It costs four lines. And the repository is
 * public, so the comparison is not something an attacker has to discover — it is
 * something they can read, along with the exact HMAC construction next to it.
 * A weakness whose difficulty rests on nobody looking is a weakness with no
 * margin left in it.
 *
 * ─── TWO GUARDS, AND WHAT EACH ONE IS ACTUALLY FOR ──────────────────────────
 * `crypto.timingSafeEqual` THROWS when the two buffers differ in length, and
 * the signature arrives in a header an attacker controls — so an unguarded call
 * would turn "bad signature" into a 500 the caller can trigger at will.
 *
 * BOTH the length check and the try/catch stop that, which is worth stating
 * plainly because a mutation test proved it: deleting the length check changed
 * no observable behaviour, since the catch returns false for the throw. An
 * earlier version of this comment claimed the length check was what prevented
 * the 500. It is not; the catch would.
 *
 * The length check earns its place for a different reason: it keeps an
 * attacker-controlled input off the exception path entirely. Relying on a throw
 * for ordinary control flow means every future refactor of the catch — someone
 * narrowing it, logging in it, re-raising — is one keystroke from a remotely
 * triggerable 500. The check makes the common rejection a plain comparison and
 * leaves the catch as a backstop that should never fire.
 *
 * `tests/unit/lib/timing-safe.test.ts` pins it by spying on timingSafeEqual and
 * asserting it is never reached with mismatched lengths, because asserting on
 * the return value cannot tell the two designs apart.
 *
 * Lengths leak by design here, which is safe: an HMAC-SHA256 hex digest is
 * always 64 characters, so a wrong length means a malformed signature rather
 * than a near-miss worth timing.
 */
import crypto from "crypto";

/**
 * Constant-time compare of two strings. Never throws, for any input.
 *
 * Returns false for a length mismatch, an empty value, or anything that is not
 * a string — every one of which is a rejected signature, not an error.
 */
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length === 0 || b.length === 0) return false;

  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  /* See the header: timingSafeEqual throws on unequal lengths, and the caller
     does not control the length of what arrives. */
  if (ab.length !== bb.length) return false;

  try {
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    /* Should be unreachable — the length check above is what normally rejects
       a mismatch. Kept so this function can never be the reason a webhook
       route returns 500, whatever a future edit does to that check. */
    return false;
  }
}
