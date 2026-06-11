/**
 * Tests for `app/api/user/hosting/trial-otp/verify/route.ts`
 * (slice 7hg, part 2). Verifies the 6-digit OTP from the
 * customer's phone and issues a signed token the trial-claim
 * flow can trust without re-querying Redis.
 *
 * Pins:
 *  - **Rate-limit BEFORE body parse** via trialOtpVerify limiter
 *    (10/IP — looser than send because legitimate typos happen)
 *  - zod schema: phone (1-20 chars) + code (`^\d{6}$` regex)
 *  - Code shape: non-numeric / wrong-length all 400
 *  - **Phone normalisation parity with send**: strip non-digits +
 *    strip leading '91' → must be 10 digits or 400 'Invalid
 *    phone number'
 *  - **consumeOtp is single-use**: route calls consumeOtp(digits,
 *    code); result.ok false → 400 INVALID_OTP with result.reason
 *    surfaced (or 'Verification failed' fallback)
 *  - **Signed token issuance on success**: signOtpToken(digits)
 *    return value is what reaches the client (NOT the raw OTP)
 *  - Outer catch → 500 SERVER_ERROR generic
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const isAllowed = vi.hoisted(() => vi.fn());
const rateLimitResponse = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rate-limit", () => ({
  rateLimiters: { trialOtpVerify: { isAllowed } },
  rateLimitResponse,
}));

const consumeOtp = vi.hoisted(() => vi.fn());
const signOtpToken = vi.hoisted(() => vi.fn());
vi.mock("@/lib/trial-otp", () => ({ consumeOtp, signOtpToken }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/user/hosting/trial-otp/verify/route";

function makeReq(body: unknown) {
  return new NextRequest(
    "https://example.com/api/user/hosting/trial-otp/verify",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }
  );
}

const validBody = { phone: "9876543210", code: "123456" };

beforeEach(() => {
  isAllowed.mockReset().mockResolvedValue({ allowed: true });
  rateLimitResponse.mockReset();
  consumeOtp.mockReset();
  signOtpToken.mockReset().mockReturnValue("SIGNED_TOKEN_FAKE");
});

describe("Rate-limit BEFORE body parse", () => {
  it("over-limit → rateLimitResponse with limit:10 (looser than send for legitimate typos); NO body parse, NO consume, NO sign", async () => {
    isAllowed.mockResolvedValueOnce({ allowed: false });
    const rlRes = new Response("rate-limited", { status: 429 });
    rateLimitResponse.mockReturnValueOnce(rlRes);

    const res = await POST(makeReq(validBody));
    expect(res).toBe(rlRes);
    expect(rateLimitResponse).toHaveBeenCalledWith(
      { allowed: false },
      {
        limit: 10,
        message: "Too many attempts. Please wait a few minutes.",
      }
    );
    expect(consumeOtp).not.toHaveBeenCalled();
    expect(signOtpToken).not.toHaveBeenCalled();
  });
});

describe("Body validation", () => {
  it("missing phone → 400", async () => {
    const res = await POST(makeReq({ code: "123456" }));
    expect(res.status).toBe(400);
  });

  it("missing code → 400", async () => {
    const res = await POST(makeReq({ phone: "9876543210" }));
    expect(res.status).toBe(400);
  });

  it("non-numeric code → 400 (regex)", async () => {
    const res = await POST(
      makeReq({ phone: "9876543210", code: "abcdef" })
    );
    expect(res.status).toBe(400);
  });

  it("5-digit code → 400 (regex requires exactly 6)", async () => {
    const res = await POST(
      makeReq({ phone: "9876543210", code: "12345" })
    );
    expect(res.status).toBe(400);
  });

  it("7-digit code → 400", async () => {
    const res = await POST(
      makeReq({ phone: "9876543210", code: "1234567" })
    );
    expect(res.status).toBe(400);
  });
});

describe("Phone normalisation (parity with send)", () => {
  it("strips non-digits + leading '91' before consumeOtp", async () => {
    consumeOtp.mockResolvedValueOnce({ ok: true });
    await POST(makeReq({ phone: "+91 98765 432-10", code: "123456" }));
    expect(consumeOtp).toHaveBeenCalledWith("9876543210", "123456");
  });

  it("9 digits after normalisation → 400 'Invalid phone number'", async () => {
    const res = await POST(
      makeReq({ phone: "987654321", code: "123456" })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid phone");
    expect(consumeOtp).not.toHaveBeenCalled();
  });

  it("11 digits after normalisation → 400", async () => {
    const res = await POST(
      makeReq({ phone: "98765432101", code: "123456" })
    );
    expect(res.status).toBe(400);
  });
});

describe("consumeOtp — single-use semantics", () => {
  it("result.ok false → 400 INVALID_OTP with result.reason surfaced", async () => {
    consumeOtp.mockResolvedValueOnce({
      ok: false,
      reason: "Code has already been used",
    });
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_OTP");
    expect(body.error).toBe("Code has already been used");
    expect(signOtpToken).not.toHaveBeenCalled();
  });

  it("result.ok false, no reason → 'Verification failed' fallback", async () => {
    consumeOtp.mockResolvedValueOnce({ ok: false });
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Verification failed");
  });
});

describe("Signed token issuance (happy path)", () => {
  it("ok → signOtpToken(digits) → 200 { success, message, token }", async () => {
    consumeOtp.mockResolvedValueOnce({ ok: true });
    signOtpToken.mockReturnValueOnce("eyJ.signed.token");

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
    expect(signOtpToken).toHaveBeenCalledWith("9876543210");
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      message: "Phone verified. You can now claim your free trial.",
      token: "eyJ.signed.token",
    });
  });

  it("token in response is the SIGNED token (NOT the raw OTP code)", async () => {
    consumeOtp.mockResolvedValueOnce({ ok: true });
    signOtpToken.mockReturnValueOnce("SIGNED_TOKEN_NOT_THE_OTP");

    const body = await (await POST(makeReq(validBody))).json();
    expect(body.token).toBe("SIGNED_TOKEN_NOT_THE_OTP");
    expect(body.token).not.toBe("123456"); // not the raw OTP
  });
});

describe("Outer catch", () => {
  it("consumeOtp throw → 500 SERVER_ERROR", async () => {
    consumeOtp.mockRejectedValueOnce(new Error("Redis down"));
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("SERVER_ERROR");
  });
});
