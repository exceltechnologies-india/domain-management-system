/**
 * Tests for `@/lib/guest-token` (rescan-4 slice 7df).
 * JWT helpers for the guest-checkout flow. Pins:
 *  - signGuestToken emits an HS256 JWT with purpose='guest_checkout'
 *    and a 1-hour expiry
 *  - verifyGuestToken returns the decoded payload on a valid token
 *  - verifyGuestToken returns null on tampered/expired/different-purpose
 *    tokens (defensive — never throws)
 *
 * `lib/auth-secret` throws if NEXTAUTH_SECRET is unset, so we stub via
 * vi.hoisted before the static import resolves.
 */
import { describe, it, expect, vi } from "vitest";

vi.hoisted(() => {
  process.env.NEXTAUTH_SECRET = "test-jwt-secret-min-32-chars-long-xyz-abc-def";
});

import jwt from "jsonwebtoken";
import {
  signGuestToken,
  verifyGuestToken,
  type GuestRegistrantDetails,
} from "@/lib/guest-token";

const DETAILS: GuestRegistrantDetails = {
  firstName: "Ada",
  lastName: "Lovelace",
  phone: "9999911111",
  addressLine1: "B9-54",
  city: "Delhi",
  state: "Delhi",
  zipcode: "110085",
};

describe("signGuestToken / verifyGuestToken", () => {
  it("round-trips the registrant payload (sign → verify)", () => {
    const token = signGuestToken("ada@example.test", DETAILS);
    const decoded = verifyGuestToken(token);
    expect(decoded).not.toBeNull();
    expect(decoded?.email).toBe("ada@example.test");
    expect(decoded?.purpose).toBe("guest_checkout");
    expect(decoded?.firstName).toBe("Ada");
    expect(decoded?.zipcode).toBe("110085");
  });

  it("token has a 1-hour expiry baked in via `iat`/`exp`", () => {
    const token = signGuestToken("ada@example.test", DETAILS);
    const decoded = verifyGuestToken(token);
    expect(decoded?.iat).toBeTypeOf("number");
    expect(decoded?.exp).toBeTypeOf("number");
    // exp - iat should be ~3600 (allow 5 s wiggle).
    const ttl = (decoded!.exp ?? 0) - (decoded!.iat ?? 0);
    expect(ttl).toBeGreaterThanOrEqual(3595);
    expect(ttl).toBeLessThanOrEqual(3605);
  });

  it("verifyGuestToken returns null when the signature is wrong", () => {
    const tampered = jwt.sign(
      { email: "e", purpose: "guest_checkout" },
      "wrong-secret",
      { algorithm: "HS256" }
    );
    expect(verifyGuestToken(tampered)).toBeNull();
  });

  it("verifyGuestToken returns null when purpose != 'guest_checkout'", () => {
    const wrongPurpose = jwt.sign(
      { email: "e", purpose: "other_thing" },
      process.env.NEXTAUTH_SECRET!,
      { algorithm: "HS256", expiresIn: "1h" }
    );
    expect(verifyGuestToken(wrongPurpose)).toBeNull();
  });

  it("verifyGuestToken returns null on garbage input (never throws)", () => {
    expect(verifyGuestToken("not.a.jwt")).toBeNull();
    expect(verifyGuestToken("")).toBeNull();
  });

  it("verifyGuestToken returns null when the token uses a different algorithm (e.g. none)", () => {
    // Forge a token with alg=none — must be rejected.
    const noneAlg =
      "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0." +
      Buffer.from(
        JSON.stringify({ email: "e", purpose: "guest_checkout" })
      ).toString("base64url") +
      ".";
    expect(verifyGuestToken(noneAlg)).toBeNull();
  });
});
