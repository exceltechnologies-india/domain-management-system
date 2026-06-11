/**
 * Tests for `app/api/user/hosting/trial-otp/send/route.ts` (slice
 * 7hg, part 1). Sends a 6-digit OTP to the customer's phone as
 * the first step of trial-claim verification.
 *
 * Pins:
 *  - **Rate-limit BEFORE body parse** via trialOtpSend limiter
 *    (3/IP — strict because SMS costs money + customer-facing
 *    SMS-bomb vector)
 *  - zod schema: phone optional, max 20 chars
 *  - **Phone resolution chain**: body.phone first, falls back to
 *    user.phone (when authenticated). NEITHER present → 400
 *    'Phone number is required'.
 *  - **Phone normalisation**: strip non-digits, strip leading '91'
 *    (Indian country code), require exactly 10 digits → otherwise
 *    400 'Please enter a valid 10-digit Indian mobile number.'
 *  - generateOtp called once; storeOtp called with (digits, code)
 *  - sendSms called with `{ to: digits, template: 'trial_otp',
 *    variables: { otp: code, var1: code } }`
 *  - SMS provider failure → **502 SMS_PROVIDER_ERROR** (NOT 500 —
 *    distinguishes upstream SMS outage from local logic bug)
 *  - Outer catch → 500 SERVER_ERROR generic
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const isAllowed = vi.hoisted(() => vi.fn());
const rateLimitResponse = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rate-limit", () => ({
  rateLimiters: { trialOtpSend: { isAllowed } },
  rateLimitResponse,
}));

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const sendSms = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sms", () => ({ sendSms }));

const generateOtp = vi.hoisted(() => vi.fn());
const storeOtp = vi.hoisted(() => vi.fn());
vi.mock("@/lib/trial-otp", () => ({ generateOtp, storeOtp }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/user/hosting/trial-otp/send/route";

function makeReq(body: unknown) {
  return new NextRequest(
    "https://example.com/api/user/hosting/trial-otp/send",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }
  );
}

beforeEach(() => {
  isAllowed.mockReset().mockResolvedValue({ allowed: true });
  rateLimitResponse.mockReset();
  getUserFromRequest.mockReset();
  sendSms.mockReset().mockResolvedValue({
    success: true,
    provider: "msg91",
  });
  generateOtp.mockReset().mockReturnValue("123456");
  storeOtp.mockReset().mockResolvedValue(undefined);
});

describe("Rate-limit BEFORE body parse", () => {
  it("over-limit → rateLimitResponse with limit:3 + 'Too many OTP requests'; NO body parse, NO SMS, NO storeOtp", async () => {
    isAllowed.mockResolvedValueOnce({ allowed: false });
    const rlRes = new Response("rate-limited", { status: 429 });
    rateLimitResponse.mockReturnValueOnce(rlRes);

    const res = await POST(makeReq({ phone: "9876543210" }));
    expect(res).toBe(rlRes);
    expect(rateLimitResponse).toHaveBeenCalledWith(
      { allowed: false },
      {
        limit: 3,
        message:
          "Too many OTP requests. Please wait a few minutes and try again.",
      }
    );
    expect(sendSms).not.toHaveBeenCalled();
    expect(storeOtp).not.toHaveBeenCalled();
  });
});

describe("Phone resolution chain", () => {
  it("body.phone wins over user.phone", async () => {
    getUserFromRequest.mockResolvedValueOnce({
      _id: "U1",
      phone: "1111111111",
    });
    await POST(makeReq({ phone: "9876543210" }));
    expect(storeOtp).toHaveBeenCalledWith("9876543210", "123456");
  });

  it("missing body.phone → falls back to user.phone", async () => {
    getUserFromRequest.mockResolvedValueOnce({
      _id: "U1",
      phone: "9876543210",
    });
    await POST(makeReq({}));
    expect(storeOtp).toHaveBeenCalledWith("9876543210", "123456");
  });

  it("body.phone absent AND no user.phone → 400 'Phone number is required'", async () => {
    getUserFromRequest.mockResolvedValueOnce({ _id: "U1" });
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Phone number is required");
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("body.phone absent AND no authenticated user → 400", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
  });
});

describe("Phone normalisation (Indian 10-digit)", () => {
  it("strips non-digits", async () => {
    await POST(makeReq({ phone: "+91 (98765) 432-10" }));
    expect(storeOtp).toHaveBeenCalledWith("9876543210", "123456");
  });

  it("strips leading 91 (country code)", async () => {
    await POST(makeReq({ phone: "919876543210" }));
    expect(storeOtp).toHaveBeenCalledWith("9876543210", "123456");
  });

  it("9-digit (after normalisation) → 400 'valid 10-digit Indian mobile'", async () => {
    const res = await POST(makeReq({ phone: "987654321" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("10-digit Indian mobile");
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("11-digit (after normalisation) → 400", async () => {
    const res = await POST(makeReq({ phone: "98765432101" }));
    expect(res.status).toBe(400);
  });
});

describe("OTP generation + SMS dispatch", () => {
  it("generateOtp → storeOtp(digits, code) → sendSms with template + vars", async () => {
    generateOtp.mockReturnValueOnce("654321");
    await POST(makeReq({ phone: "9876543210" }));

    expect(generateOtp).toHaveBeenCalledTimes(1);
    expect(storeOtp).toHaveBeenCalledWith("9876543210", "654321");
    expect(sendSms).toHaveBeenCalledWith({
      to: "9876543210",
      template: "trial_otp",
      variables: { otp: "654321", var1: "654321" },
    });
  });

  it("happy path → 200 with success message + provider", async () => {
    sendSms.mockResolvedValueOnce({ success: true, provider: "msg91" });
    const res = await POST(makeReq({ phone: "9876543210" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      message: "OTP sent. Please check your phone.",
      provider: "msg91",
    });
  });
});

describe("SMS provider failure → 502 (NOT 500)", () => {
  it("sendSms returns success:false → 502 SMS_PROVIDER_ERROR (upstream-outage signal)", async () => {
    sendSms.mockResolvedValueOnce({
      success: false,
      provider: "msg91",
      error: "MSG91 503",
    });
    const res = await POST(makeReq({ phone: "9876543210" }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("SMS_PROVIDER_ERROR");
    expect(body.error).toContain("Could not send the OTP");
  });
});

describe("Outer catch", () => {
  it("storeOtp throw → 500 SERVER_ERROR", async () => {
    storeOtp.mockRejectedValueOnce(new Error("Redis down"));
    const res = await POST(makeReq({ phone: "9876543210" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("SERVER_ERROR");
  });
});
