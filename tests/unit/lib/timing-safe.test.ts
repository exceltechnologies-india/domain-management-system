/**
 * `safeEqual` — the one comparison used for every signature this app receives.
 *
 * ─── WHAT THESE TESTS ARE REALLY FOR ────────────────────────────────────────
 * They cannot measure timing. Asserting that two comparisons take the same
 * number of nanoseconds inside a JIT on a shared CI runner produces a test that
 * fails on a busy afternoon, which is worse than no test.
 *
 * What they CAN pin is every way this function could be wrong in a way that
 * matters, and one of those bit this repo already: the version that existed in
 * `app/api/webhooks/whatsapp/route.ts` was correct, and the two Razorpay
 * verifiers used `===` instead, because there was no shared helper to reach for.
 *
 * The length guard is the load-bearing case. `crypto.timingSafeEqual` THROWS on
 * buffers of different length, and the signature comes from a header an
 * unauthenticated caller controls — so a missing guard turns "bad signature"
 * into a 500, which is a denial of service the caller can trigger at will.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import crypto from "crypto";
import { safeEqual } from "@/lib/timing-safe";

afterEach(() => vi.restoreAllMocks());

const HMAC = (body: string, secret: string) =>
  crypto.createHmac("sha256", secret).update(body).digest("hex");

describe("safeEqual", () => {
  it("accepts two identical signatures", () => {
    const sig = HMAC('{"event":"payment.captured"}', "whsec_test");
    expect(safeEqual(sig, sig)).toBe(true);
  });

  it("rejects a signature for a different body", () => {
    const a = HMAC('{"amount":100}', "whsec_test");
    const b = HMAC('{"amount":100000}', "whsec_test");
    expect(safeEqual(a, b)).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    const body = '{"event":"payment.captured"}';
    expect(safeEqual(HMAC(body, "real"), HMAC(body, "guess"))).toBe(false);
  });

  /* ─── THE GUARD THAT STOPS A 500 ────────────────────────────────────────
     Each of these is a length an attacker can send in the signature header.
     Without the length check every one of them throws out of the comparison
     and the route answers 500 — on demand, for free. */
  it("returns false rather than throwing on a length mismatch", () => {
    const sig = HMAC("{}", "s");
    expect(() => safeEqual(sig, sig.slice(0, 10))).not.toThrow();
    expect(safeEqual(sig, sig.slice(0, 10))).toBe(false);
    expect(safeEqual(sig, sig + "00")).toBe(false);
    expect(safeEqual(sig, "x")).toBe(false);
    expect(safeEqual(sig, "x".repeat(5000))).toBe(false);
  });

  /* A correct prefix must not pass. This is the case a `startsWith` or a
     truncating comparison would let through, and it is the whole point. */
  it("rejects a correct prefix of the right signature", () => {
    const sig = HMAC('{"event":"refund.processed"}', "whsec_test");
    expect(safeEqual(sig, sig.slice(0, 63))).toBe(false);
    /* Flip the last nibble to something it is NOT. Appending a fixed "0" here
       passed or failed depending on the digest: one hex digest in sixteen ends
       in "0", and for those this rebuilt the REAL signature and safeEqual was
       right to return true. The fixture was wrong, not the function. */
    const flipped = sig.slice(0, 63) + (sig[63] === "0" ? "1" : "0");
    expect(flipped).not.toBe(sig);
    expect(safeEqual(sig, flipped)).toBe(false);
  });

  /* Missing headers arrive as null, and an empty string must never compare
     equal to an empty string — otherwise omitting the header entirely, on a
     deployment whose secret failed to load, would VERIFY. */
  it("rejects null, undefined and empty values", () => {
    const sig = HMAC("{}", "s");
    expect(safeEqual(null, sig)).toBe(false);
    expect(safeEqual(sig, null)).toBe(false);
    expect(safeEqual(undefined, sig)).toBe(false);
    expect(safeEqual("", "")).toBe(false);
    expect(safeEqual(null, null)).toBe(false);
  });

  /* ─── THE GUARD, PINNED WHERE IT IS VISIBLE ─────────────────────────────
     Written because a mutation survived: deleting the length check left every
     assertion above green, since the try/catch returns false for the throw
     either way. The two designs are indistinguishable from the return value,
     so the test has to look at whether the throwing call happens at all.

     What this protects is the principle, not the current output: an
     attacker-controlled length must be rejected by a comparison, never by
     catching an exception, so that narrowing or re-raising in that catch later
     cannot hand out a remotely triggerable 500. */
  it("never reaches timingSafeEqual with mismatched lengths", () => {
    const spy = vi.spyOn(crypto, "timingSafeEqual");
    const sig = HMAC("{}", "s");

    expect(safeEqual(sig, sig.slice(0, 10))).toBe(false);
    expect(safeEqual(sig, "x".repeat(5000))).toBe(false);
    expect(safeEqual(sig, "")).toBe(false);
    expect(spy).not.toHaveBeenCalled();

    /* And it IS reached for equal lengths — otherwise this test would also
       pass on a function that always returned false without comparing. */
    expect(safeEqual(sig, sig)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("is case-sensitive, so a re-cased hex digest is not accepted", () => {
    const sig = HMAC('{"a":1}', "s");
    expect(safeEqual(sig, sig.toUpperCase())).toBe(false);
  });

  /* Multi-byte input must not be compared by character count. Buffer length
     and string length disagree here, and timingSafeEqual works on buffers. */
  it("handles non-ASCII without throwing", () => {
    expect(() => safeEqual("é", "e")).not.toThrow();
    expect(safeEqual("é", "e")).toBe(false);
    expect(safeEqual("é", "é")).toBe(true);
  });
});
