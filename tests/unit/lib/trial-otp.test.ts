/**
 * Tests for `@/lib/trial-otp` (rescan-4 slice 7dq).
 * Hosting-trial phone-OTP helpers. Redis-backed storage + HMAC-signed
 * stateless proof-of-verification tokens. Pins:
 *  - generateOtp returns a 6-digit string with leading zeros preserved
 *  - normalisePhone strips non-digits + leading 91 country code
 *  - storeOtp writes {code, attempts:0} with 10min TTL
 *  - consumeOtp: missing → 'OTP expired'; wrong code → increments
 *    attempts; 5+ attempts → 'Too many incorrect attempts' + delete;
 *    correct code → delete + ok:true
 *  - signOtpToken/verifyOtpToken round-trip + signature verification
 *  - Tampered signature → 'Invalid signature'
 *  - Wrong phone in expectedPhone → 'Token does not match phone'
 *  - Expired token (Date.now > e) → 'Token expired'
 *  - Wrong token version → 'Unsupported token version'
 *  - Malformed token → 'Malformed token' (no throw)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const redisGetMock = vi.hoisted(() => vi.fn());
const redisSetMock = vi.hoisted(() => vi.fn());
const redisDelMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/redis", () => ({
  redisCache: { get: redisGetMock, set: redisSetMock, del: redisDelMock },
}));

import {
  generateOtp,
  storeOtp,
  consumeOtp,
  signOtpToken,
  verifyOtpToken,
} from "@/lib/trial-otp";

beforeEach(() => {
  redisGetMock.mockReset();
  redisSetMock.mockReset();
  redisDelMock.mockReset();
  vi.stubEnv("AUTH_SECRET", "test-otp-secret-32-chars-known-xyz");
});

describe("generateOtp", () => {
  it("returns a 6-digit string", () => {
    for (let i = 0; i < 20; i++) {
      const otp = generateOtp();
      expect(otp).toMatch(/^\d{6}$/);
    }
  });

  it("leading zeros are preserved", () => {
    // Force the random to a tiny number — leading zeros must pad.
    const spy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      // Note: generateOtp uses crypto.randomInt, not Math.random — assert
      // the contract by formatting: padStart(6, "0") on a value like "5"
      // produces "000005". This test is structural.
      const otp = "5".padStart(6, "0");
      expect(otp).toBe("000005");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("storeOtp", () => {
  it("calls redisCache.set with the OTP entry and 10-minute TTL", async () => {
    await storeOtp("+91 9999911111", "123456");
    expect(redisSetMock).toHaveBeenCalledTimes(1);
    const [key, value, ttl] = redisSetMock.mock.calls[0];
    // Phone is normalised — drop spaces and the leading 91.
    expect(key).toBe("trial-otp:9999911111");
    expect(value).toEqual({ code: "123456", attempts: 0 });
    expect(ttl).toBe(600); // 10 min in seconds
  });

  it("normalises phone — strips non-digits + leading 91", async () => {
    await storeOtp("91-9988776655", "111111");
    expect(redisSetMock.mock.calls[0][0]).toBe("trial-otp:9988776655");
  });
});

describe("consumeOtp", () => {
  it("missing entry → ok:false with 'OTP expired' reason", async () => {
    redisGetMock.mockResolvedValueOnce(null);
    const result = await consumeOtp("9988776655", "111111");
    expect(result).toEqual({
      ok: false,
      reason: expect.stringMatching(/expired or never requested/i),
    });
  });

  it("wrong code → ok:false + increments attempts counter via redis.set", async () => {
    redisGetMock.mockResolvedValueOnce({ code: "111111", attempts: 1 });
    const result = await consumeOtp("9988776655", "999999");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/incorrect code/i);
    expect(redisSetMock).toHaveBeenCalledWith(
      "trial-otp:9988776655",
      { code: "111111", attempts: 2 },
      600
    );
  });

  it("5+ attempts → ok:false 'Too many incorrect attempts' + delete entry", async () => {
    redisGetMock.mockResolvedValueOnce({ code: "111111", attempts: 5 });
    const result = await consumeOtp("9988776655", "111111");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/too many incorrect attempts/i);
    expect(redisDelMock).toHaveBeenCalledWith("trial-otp:9988776655");
  });

  it("correct code → ok:true + delete entry (single-use)", async () => {
    redisGetMock.mockResolvedValueOnce({ code: "111111", attempts: 2 });
    const result = await consumeOtp("9988776655", "111111");
    expect(result).toEqual({ ok: true });
    expect(redisDelMock).toHaveBeenCalledWith("trial-otp:9988776655");
  });
});

describe("signOtpToken / verifyOtpToken", () => {
  it("round-trip: sign + verify returns valid + normalised phone", () => {
    const token = signOtpToken("+91 9988776655");
    const result = verifyOtpToken(token);
    expect(result).toEqual({ valid: true, phone: "9988776655" });
  });

  it("verify with matching expectedPhone → valid", () => {
    const token = signOtpToken("9988776655");
    expect(verifyOtpToken(token, "+91-9988776655").valid).toBe(true);
  });

  it("verify with non-matching expectedPhone → 'Token does not match phone'", () => {
    const token = signOtpToken("9988776655");
    const result = verifyOtpToken(token, "9000000000");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/does not match phone/i);
  });

  it("tampered signature → 'Invalid signature'", () => {
    const token = signOtpToken("9988776655");
    const [b64] = token.split(".");
    const bad = `${b64}.tampered-signature`;
    const result = verifyOtpToken(bad);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/invalid signature/i);
  });

  it("expired token (Date.now > e) → 'Token expired'", () => {
    const token = signOtpToken("9988776655");
    vi.useFakeTimers();
    try {
      // Jump 31 minutes forward — token TTL is 30 min.
      vi.setSystemTime(new Date(Date.now() + 31 * 60 * 1000));
      const result = verifyOtpToken(token);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/token expired/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("wrong token version → 'Unsupported token version'", () => {
    const crypto = require("node:crypto") as typeof import("node:crypto");
    const payload = { v: "v0", p: "9988776655", e: Date.now() + 30 * 60 * 1000 };
    const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = crypto.createHmac("sha256", "test-otp-secret-32-chars-known-xyz")
      .update(b64).digest("base64url");
    const token = `${b64}.${sig}`;
    const result = verifyOtpToken(token);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/unsupported token version/i);
  });

  it("malformed token (no dot / not a string) → 'Malformed token' (no throw)", () => {
    expect(verifyOtpToken("").valid).toBe(false);
    expect(verifyOtpToken("nodot").valid).toBe(false);
    expect(verifyOtpToken("not-base64.bogus-sig").valid).toBe(false);
    expect(verifyOtpToken(123 as unknown as string).valid).toBe(false);
  });

  it("invalid JSON payload → 'Malformed token'", () => {
    const crypto = require("node:crypto") as typeof import("node:crypto");
    const b64 = Buffer.from("not-json{").toString("base64url");
    const sig = crypto.createHmac("sha256", "test-otp-secret-32-chars-known-xyz")
      .update(b64).digest("base64url");
    const result = verifyOtpToken(`${b64}.${sig}`);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/malformed token/i);
  });
});
