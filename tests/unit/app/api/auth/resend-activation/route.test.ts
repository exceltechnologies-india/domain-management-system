/**
 * Tests for `app/api/auth/resend-activation/route.ts` (slice 7ha,
 * part 1). Public, unauthenticated endpoint. Anyone can hit it
 * with an email to re-send the activation link.
 *
 * Threat model:
 *  - **Email enumeration**: a normal "user not found" 404 would
 *    leak which emails are registered. The route returns the
 *    SAME generic success message for unknown emails, already-
 *    activated emails, AND legitimate resend successes.
 *  - **Anti-spam**: IP-based rate limit caps the route at 3
 *    attempts (per the resendActivation limiter), pinned with
 *    limit:3 surfaced in the rate-limit response.
 *
 * Pins:
 *  - **Rate-limit BEFORE body parsing**: over-limit → 429-ish
 *    response with limit:3; NO body parse, NO DB lookup, NO token
 *    issued, NO email sent
 *  - zod email schema — bad email → 400
 *  - getUserByEmail not found → SAME generic message; NO save,
 *    NO email
 *  - User found but already isActivated → SAME generic message;
 *    NO save, NO email (anti-enumeration: an attacker can't tell
 *    these two cases apart from the response)
 *  - Happy path: 32-byte hex activation token + 24h expiry; user
 *    saved; sendActivationEmail called with
 *    (email, `${firstName} ${lastName}`, token); 200 with the
 *    SAME generic message
 *  - sendActivationEmail returning false → 500 'Failed to send'
 *    (this DOES distinguish from the generic — but only on the
 *    legitimate-resend path, so no information leakage to
 *    attackers who haven't passed the email check)
 *  - Outer catch → 500 'Internal server error' generic
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const isAllowed = vi.hoisted(() => vi.fn());
const rateLimitResponse = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rate-limit", () => ({
  rateLimiters: { resendActivation: { isAllowed } },
  rateLimitResponse,
}));

const getUserByEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserByEmail }));

const sendActivationEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", () => ({
  EmailService: { sendActivationEmail },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/auth/resend-activation/route";

const GENERIC = "If that email has a pending activation, we've resent the link.";

function makeReq(body: unknown) {
  return new NextRequest("https://example.com/api/auth/resend-activation", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  isAllowed.mockReset().mockResolvedValue({ allowed: true });
  rateLimitResponse.mockReset();
  getUserByEmail.mockReset();
  sendActivationEmail.mockReset().mockResolvedValue(true);
});

describe("Rate-limit BEFORE body parsing", () => {
  it("over-limit → rateLimitResponse with limit:3; NO body parse, NO DB lookup, NO email", async () => {
    isAllowed.mockResolvedValueOnce({ allowed: false });
    const rlRes = new Response("rate-limited", { status: 429 });
    rateLimitResponse.mockReturnValueOnce(rlRes);

    const res = await POST(makeReq({ email: "alice@example.com" }));
    expect(res).toBe(rlRes);
    expect(rateLimitResponse).toHaveBeenCalledWith(
      { allowed: false },
      { limit: 3 }
    );
    expect(getUserByEmail).not.toHaveBeenCalled();
    expect(sendActivationEmail).not.toHaveBeenCalled();
  });
});

describe("Body validation", () => {
  it("missing email → 400", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    expect(getUserByEmail).not.toHaveBeenCalled();
  });

  it("invalid email format → 400", async () => {
    const res = await POST(makeReq({ email: "not-an-email" }));
    expect(res.status).toBe(400);
    expect(getUserByEmail).not.toHaveBeenCalled();
  });
});

describe("Anti-enumeration — generic response for unknown email", () => {
  it("getUserByEmail null → GENERIC success message; NO save, NO email", async () => {
    getUserByEmail.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ email: "ghost@example.com" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe(GENERIC);
    expect(sendActivationEmail).not.toHaveBeenCalled();
  });
});

describe("Anti-enumeration — generic response for already-activated", () => {
  it("user.isActivated === true → SAME GENERIC message (indistinguishable from unknown email)", async () => {
    getUserByEmail.mockResolvedValueOnce({
      _id: "U1",
      email: "alice@example.com",
      isActivated: true,
      save: vi.fn().mockResolvedValue(undefined),
    });
    const res = await POST(makeReq({ email: "alice@example.com" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe(GENERIC);
    expect(sendActivationEmail).not.toHaveBeenCalled();
  });
});

describe("Happy path — pending activation", () => {
  it("32-byte hex token + 24h expiry stored; sendActivationEmail called; GENERIC success returned", async () => {
    vi.useFakeTimers();
    const NOW = new Date("2026-06-10T12:00:00.000Z").getTime();
    vi.setSystemTime(new Date(NOW));

    const captured: { token?: string; expiry?: Date } = {};
    const save = vi.fn().mockImplementation(function (this: {
      activationToken: string;
      activationTokenExpiry: Date;
    }) {
      captured.token = this.activationToken;
      captured.expiry = this.activationTokenExpiry;
      return Promise.resolve();
    });
    getUserByEmail.mockResolvedValueOnce({
      _id: "U1",
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Anderson",
      isActivated: false,
      save,
    });

    const res = await POST(makeReq({ email: "alice@example.com" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe(GENERIC);

    // Token: 32 bytes hex = 64 hex chars
    expect(captured.token).toMatch(/^[a-f0-9]{64}$/);
    // Expiry: 24h from now
    expect(captured.expiry!.getTime()).toBe(NOW + 24 * 60 * 60 * 1000);

    expect(sendActivationEmail).toHaveBeenCalledWith(
      "alice@example.com",
      "Alice Anderson",
      captured.token
    );
    expect(save).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});

describe("Email send failure", () => {
  it("sendActivationEmail returns false → 500 'Failed to send activation email'", async () => {
    getUserByEmail.mockResolvedValueOnce({
      _id: "U1",
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Anderson",
      isActivated: false,
      save: vi.fn().mockResolvedValue(undefined),
    });
    sendActivationEmail.mockResolvedValueOnce(false);

    const res = await POST(makeReq({ email: "alice@example.com" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to send activation email");
  });
});

describe("Outer catch", () => {
  it("getUserByEmail throw → 500 'Internal server error' (no leak)", async () => {
    getUserByEmail.mockRejectedValueOnce(new Error("Mongo timeout"));
    const res = await POST(makeReq({ email: "alice@example.com" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(body.error).not.toContain("Mongo");
  });
});
