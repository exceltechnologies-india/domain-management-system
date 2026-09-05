/**
 * Tests for `app/api/auth/activate/route.ts` (slice 7hd, part 1).
 * Customer activates their account by following the link from the
 * activation email. On success: clears the token, issues a JWT
 * for immediate login, and returns the curated user payload.
 *
 * Pins:
 *  - **Rate-limit BEFORE body parse**: activation limiter (10/IP);
 *    over-limit → rateLimitResponse with limit:10 + 'Too many
 *    activation attempts'; NO body parse, NO DB lookup, NO JWT
 *  - zod token: 1-256 chars
 *  - **Expired-vs-unknown branch**: findUserByActivationToken(token)
 *    null → check findUserByActivationToken(token, {onlyExpired:true})
 *    to distinguish. If onlyExpired returns a row → 400 'Token
 *    expired' (so customer knows to request a fresh one);
 *    otherwise → 400 'Invalid token'.
 *  - **Already-activated guard**: user.isActivated → 200 with
 *    `alreadyActivated: true` and NO JWT. A repeat click on a good
 *    link is not a failure; it is a customer arriving at an account
 *    that is already live, and belongs on the sign-in path.
 *  - **Token RETAINED on success**: activationToken and
 *    activationTokenExpiry survive activation, because the lookup
 *    keys on activationToken — clearing it made every repeat hit
 *    unidentifiable and rendered the guard above dead code, so the
 *    customer got "Invalid Activation Link … Register Again" for an
 *    account that had just activated. Email providers PREFETCH links,
 *    so this fired before the human even clicked. Replay is harmless:
 *    the isActivated guard returns before any mutation and mints no JWT.
 *  - JWT issued via AuthService.generateToken(payload); response
 *    carries the token + curated user fields
 *  - Outer catch → 500 'Internal server error' generic
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const isAllowed = vi.hoisted(() => vi.fn());
const rateLimitResponse = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rate-limit", () => ({
  rateLimiters: { activation: { isAllowed } },
  rateLimitResponse,
}));

const findUserByActivationToken = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ findUserByActivationToken }));

const generateToken = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { generateToken },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/auth/activate/route";

function makeReq(body: unknown) {
  return new NextRequest("https://example.com/api/auth/activate", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const VALID_TOKEN = "a".repeat(64);

beforeEach(() => {
  isAllowed.mockReset().mockResolvedValue({ allowed: true });
  rateLimitResponse.mockReset();
  findUserByActivationToken.mockReset();
  generateToken.mockReset().mockReturnValue("JWT_FAKE");
});

describe("Rate-limit BEFORE body parse", () => {
  it("over-limit → rateLimitResponse with limit:10 + 'Too many'; NO body parse, NO lookup, NO JWT", async () => {
    isAllowed.mockResolvedValueOnce({ allowed: false });
    const rlRes = new Response("rate-limited", { status: 429 });
    rateLimitResponse.mockReturnValueOnce(rlRes);

    const res = await POST(makeReq({ token: VALID_TOKEN }));
    expect(res).toBe(rlRes);
    expect(rateLimitResponse).toHaveBeenCalledWith(
      { allowed: false },
      {
        limit: 10,
        message: "Too many activation attempts. Please try again later.",
      }
    );
    expect(findUserByActivationToken).not.toHaveBeenCalled();
    expect(generateToken).not.toHaveBeenCalled();
  });
});

describe("Body validation", () => {
  it("missing token → 400", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    expect(findUserByActivationToken).not.toHaveBeenCalled();
  });

  it("empty token → 400 (min:1 in schema)", async () => {
    const res = await POST(makeReq({ token: "" }));
    expect(res.status).toBe(400);
  });

  it("oversize token > 256 chars → 400", async () => {
    const res = await POST(makeReq({ token: "x".repeat(257) }));
    expect(res.status).toBe(400);
  });
});

describe("Expired-vs-unknown token branch", () => {
  it("token unknown AND no expired row → 400 'Invalid token'", async () => {
    findUserByActivationToken
      .mockResolvedValueOnce(null) // first call (active)
      .mockResolvedValueOnce(null); // second call (onlyExpired)

    const res = await POST(makeReq({ token: VALID_TOKEN }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid token");
  });

  it("token unknown BUT expired row found → 400 'Token expired' (so customer knows to request fresh)", async () => {
    findUserByActivationToken
      .mockResolvedValueOnce(null) // first call (active)
      .mockResolvedValueOnce({ _id: "U_EXPIRED" }); // onlyExpired hit

    const res = await POST(makeReq({ token: VALID_TOKEN }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Token expired");
  });

  it("the expired-lookup is gated on the FIRST being null (avoid extra DB hit on happy path)", async () => {
    findUserByActivationToken.mockResolvedValueOnce({
      _id: "U1",
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Anderson",
      role: "user",
      isActivated: false,
      profileCompleted: false,
      provider: "credentials",
      save: vi.fn().mockResolvedValue(undefined),
    });

    await POST(makeReq({ token: VALID_TOKEN }));
    // only ONE call — happy path doesn't probe for expired-token
    expect(findUserByActivationToken).toHaveBeenCalledTimes(1);
  });

  it("first lookup pins arguments: (token) — no opts", async () => {
    findUserByActivationToken.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await POST(makeReq({ token: VALID_TOKEN }));
    expect(findUserByActivationToken).toHaveBeenNthCalledWith(1, VALID_TOKEN);
  });

  it("second lookup pins arguments: (token, {onlyExpired: true})", async () => {
    findUserByActivationToken.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await POST(makeReq({ token: VALID_TOKEN }));
    expect(findUserByActivationToken).toHaveBeenNthCalledWith(2, VALID_TOKEN, {
      onlyExpired: true,
    });
  });
});

describe("Already-activated guard", () => {
  // A repeat hit on a good link is NOT a failure. The route used to answer 400
  // here, and — worse — the guard was unreachable anyway, because activation
  // erased `activationToken` and the lookup keys on it. So the second click
  // (or an email provider's link PREFETCH, which consumes it before the human
  // clicks at all) fell through to "Invalid token" and the customer saw
  // "Invalid Activation Link … Register Again" for an account that was live.
  it("user.isActivated → 200 + alreadyActivated flag; NO re-save, NO JWT", async () => {
    const save = vi.fn();
    findUserByActivationToken.mockResolvedValueOnce({
      _id: "U1",
      email: "alice@example.com",
      isActivated: true,
      save,
    });
    const res = await POST(makeReq({ token: VALID_TOKEN }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alreadyActivated).toBe(true);
    expect(body.message).toMatch(/already activated/i);
    expect(body.user.email).toBe("alice@example.com");
    expect(body.user.isActivated).toBe(true);
    // Nothing to mint or mutate for an account that is already live.
    expect(save).not.toHaveBeenCalled();
    expect(generateToken).not.toHaveBeenCalled();
    expect(body.token).toBeUndefined();
  });

  it("expired row that IS activated → 200, not 'Token expired'", async () => {
    // Came back to an old link long after using it. Sending this customer off
    // to request a fresh activation for an already-active account is wrong.
    findUserByActivationToken
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: "U1", email: "alice@example.com", isActivated: true });
    const res = await POST(makeReq({ token: VALID_TOKEN }));
    expect(res.status).toBe(200);
    expect((await res.json()).alreadyActivated).toBe(true);
  });

  it("expired row that is NOT activated still → 400 'Token expired'", async () => {
    // The genuine expiry case must keep working — this customer really does
    // need a fresh link.
    findUserByActivationToken
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: "U2", email: "bob@example.com", isActivated: false });
    const res = await POST(makeReq({ token: VALID_TOKEN }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Token expired");
  });
});

describe("Happy path — activate + JWT (token RETAINED)", () => {
  it("activates user, RETAINS token + expiry, saves, issues JWT, returns curated user", async () => {
    const captured: {
      isActivated?: boolean;
      activationToken?: string;
      activationTokenExpiry?: Date;
    } = {};
    const save = vi.fn().mockImplementation(function (this: {
      isActivated: boolean;
      activationToken?: string;
      activationTokenExpiry?: Date;
    }) {
      captured.isActivated = this.isActivated;
      captured.activationToken = this.activationToken;
      captured.activationTokenExpiry = this.activationTokenExpiry;
      return Promise.resolve();
    });

    findUserByActivationToken.mockResolvedValueOnce({
      _id: "U1",
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Anderson",
      role: "user",
      isActivated: false,
      profileCompleted: false,
      provider: "credentials",
      phone: "1234567890",
      phoneCc: "+91",
      companyName: "Anutech",
      address: "Mumbai",
      activationToken: VALID_TOKEN,
      activationTokenExpiry: new Date("2026-06-12"),
      save,
    });

    const res = await POST(makeReq({ token: VALID_TOKEN }));
    expect(res.status).toBe(200);

    // Activation flips, but the token is deliberately KEPT: clearing it made
    // every repeat click on a valid link unidentifiable (the lookup keys on
    // `activationToken`), so the customer got "Invalid Activation Link …
    // Register Again" for an account that had just gone live. Retaining it is
    // safe — the isActivated guard short-circuits before any mutation.
    expect(captured.isActivated).toBe(true);
    expect(captured.activationToken).toBe(VALID_TOKEN);
    expect(captured.activationTokenExpiry).toEqual(new Date("2026-06-12"));
    expect(save).toHaveBeenCalledTimes(1);

    // JWT issued with payload
    expect(generateToken).toHaveBeenCalledWith({
      userId: "U1",
      email: "alice@example.com",
      role: "user",
    });

    const body = await res.json();
    expect(body.token).toBe("JWT_FAKE");
    expect(body.message).toContain("activated successfully");
    expect(body.user).toEqual({
      id: "U1",
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Anderson",
      role: "user",
      isActivated: true,
      profileCompleted: false,
      provider: "credentials",
      phone: "1234567890",
      phoneCc: "+91",
      companyName: "Anutech",
      address: "Mumbai",
    });
  });

  it("NEGATIVE leak guard: response must NOT carry activationToken / password / totpSecret", async () => {
    findUserByActivationToken.mockResolvedValueOnce({
      _id: "U1",
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Anderson",
      role: "user",
      isActivated: false,
      profileCompleted: false,
      provider: "credentials",
      // Internal fields injected to confirm they don't leak:
      activationToken: VALID_TOKEN,
      activationTokenExpiry: new Date("2026-06-12"),
      password: "$2a$12$BCRYPT_HASH_LEAK_ME",
      totpSecret: "JBSWY3DPEHPK3PXP_LEAK",
      sessionInvalidatedAt: new Date("2026-06-10"),
      save: vi.fn().mockResolvedValue(undefined),
    });

    const body = await (await POST(makeReq({ token: VALID_TOKEN }))).json();
    const json = JSON.stringify(body);
    expect(json).not.toContain("BCRYPT_HASH_LEAK");
    expect(json).not.toContain("JBSWY3DPEHPK3PXP_LEAK");
    expect(json).not.toContain("activationToken");
    expect(json).not.toContain("sessionInvalidatedAt");
  });
});

describe("Outer catch", () => {
  it("findUserByActivationToken throw → 500 'Internal server error'", async () => {
    findUserByActivationToken.mockRejectedValueOnce(
      new Error("Mongo timeout")
    );
    const res = await POST(makeReq({ token: VALID_TOKEN }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(body.error).not.toContain("Mongo");
  });
});
