/**
 * Tests for `app/api/user/settings/change-email/route.ts` (slice 7gd,
 * part 1). Customer-initiated email change — the request half of the
 * two-step ATO-resistant flow. The /verify-email-change handler
 * completes the change.
 *
 * Critical security invariants pinned here:
 *  - **Auth gate FIRST** — no user → 401 UNAUTHORIZED via
 *    secureErrorResponse (no token issued without a session)
 *  - **Social-login lockout** — provider !== 'credentials' → 400
 *    SOCIAL_ACCOUNT (Google/etc. accounts have no password and so
 *    can't satisfy the password re-prompt; better to block the
 *    flow than to let it leak that no password exists)
 *  - **Body validation** — invalid body → 400 from validatedBody
 *    (zod schema rejects missing newEmail / missing currentPassword
 *    / bad email format)
 *  - **Same-email guard** — normalised newEmail equals current
 *    user.email.toLowerCase() → 400 SAME_EMAIL (prevents wasted
 *    DB writes + spurious notification emails)
 *  - **NO_PASSWORD when getUserWithPassword returns no record or
 *    no password** (e.g. mid-migration) — 400 NO_PASSWORD (guards
 *    the comparePassword call from crashing on undefined)
 *  - **Password re-prompt** — userWithPassword.comparePassword
 *    rejects → 401 INVALID_PASSWORD (this is the ATO defence: a
 *    hijacked session can't change the email without the password)
 *  - **Email-enumeration prevention** — if newEmail is already
 *    registered to ANOTHER user, return the SAME success-shaped
 *    message as a real success ("If that address is available...")
 *    so a probe can't tell registered emails from unregistered ones
 *  - **Token shape** — crypto.randomBytes(32).toString('hex') gives
 *    64 hex chars (raw, sent to user via email link); SHA-256 hash
 *    of that raw token is what gets stored on the user record (so
 *    even DB exfil doesn't give the attacker a usable token)
 *  - **TTL = 1 hour** — pendingEmailExpiry set to now + 60*60*1000ms
 *  - **Two emails sent** — confirmation link to NEW address +
 *    security alert to OLD address (the security alert is the
 *    canary for compromised accounts)
 *  - **Generic 500 on outer throw** — secureErrorResponse hides DB
 *    internals from clients
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const getUserByEmail = vi.hoisted(() => vi.fn());
const getUserWithPassword = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({
  getUserByEmail,
  getUserWithPassword,
}));

const sendEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email/transporter", () => ({ sendEmail }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/user/settings/change-email/route";

function makeReq(body: unknown) {
  return new NextRequest("https://example.com/api/user/settings/change-email", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

type FakeUserWithPwd = {
  _id: string;
  email: string;
  firstName: string;
  lastName: string;
  password: string | undefined;
  comparePassword: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  pendingEmail: string | undefined;
  pendingEmailToken: string | undefined;
  pendingEmailExpiry: Date | undefined;
};

function userWithPwd(overrides: Partial<FakeUserWithPwd> = {}): FakeUserWithPwd {
  return {
    _id: "U1",
    email: "alice@example.com",
    firstName: "Alice",
    lastName: "Anderson",
    password: "hashed",
    comparePassword: vi.fn().mockResolvedValue(true),
    save: vi.fn().mockResolvedValue(undefined),
    pendingEmail: undefined,
    pendingEmailToken: undefined,
    pendingEmailExpiry: undefined,
    ...overrides,
  };
}

const sessionUser = {
  _id: "U1",
  email: "alice@example.com",
  provider: "credentials",
};

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(sessionUser);
  getUserByEmail.mockReset().mockResolvedValue(null);
  getUserWithPassword.mockReset();
  sendEmail.mockReset().mockResolvedValue(undefined);
});

// ─── Auth gate ────────────────────────────────────────────────────
describe("Auth gate FIRST", () => {
  it("no user → 401 UNAUTHORIZED; no body parsing, no email send", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ newEmail: "x@y.com", currentPassword: "p" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
    expect(getUserWithPassword).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

// ─── Social-login lockout ─────────────────────────────────────────
describe("Social-login lockout", () => {
  it("provider='google' → 400 SOCIAL_ACCOUNT (no password to verify against)", async () => {
    getUserFromRequest.mockResolvedValueOnce({
      ...sessionUser,
      provider: "google",
    });
    const res = await POST(
      makeReq({ newEmail: "new@example.com", currentPassword: "p" })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("SOCIAL_ACCOUNT");
    expect(getUserWithPassword).not.toHaveBeenCalled();
  });

  it("provider='credentials' allowed through", async () => {
    getUserFromRequest.mockResolvedValueOnce({
      ...sessionUser,
      provider: "credentials",
    });
    getUserWithPassword.mockResolvedValueOnce(userWithPwd());
    const res = await POST(
      makeReq({ newEmail: "new@example.com", currentPassword: "p" })
    );
    // success path returns 200 with the email-enumeration-safe message
    expect(res.status).toBe(200);
  });

  it("provider undefined (legacy local accounts) allowed through", async () => {
    getUserFromRequest.mockResolvedValueOnce({
      ...sessionUser,
      provider: undefined,
    });
    getUserWithPassword.mockResolvedValueOnce(userWithPwd());
    const res = await POST(
      makeReq({ newEmail: "new@example.com", currentPassword: "p" })
    );
    expect(res.status).toBe(200);
  });
});

// ─── Body validation ──────────────────────────────────────────────
describe("Body validation", () => {
  it("missing newEmail → 400 VALIDATION_ERROR", async () => {
    const res = await POST(makeReq({ currentPassword: "p" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("missing currentPassword → 400 VALIDATION_ERROR", async () => {
    const res = await POST(makeReq({ newEmail: "x@y.com" }));
    expect(res.status).toBe(400);
  });

  it("invalid email format → 400 VALIDATION_ERROR", async () => {
    const res = await POST(makeReq({ newEmail: "not-an-email", currentPassword: "p" }));
    expect(res.status).toBe(400);
  });

  it("invalid JSON body → 400 INVALID_JSON", async () => {
    const req = new NextRequest(
      "https://example.com/api/user/settings/change-email",
      {
        method: "POST",
        body: "not-json",
        headers: { "content-type": "application/json" },
      }
    );
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_JSON");
  });
});

// ─── Same-email guard ─────────────────────────────────────────────
describe("Same-email guard", () => {
  it("newEmail equals current (case-insensitive — schema lowercases) → 400 SAME_EMAIL", async () => {
    const res = await POST(
      makeReq({ newEmail: "ALICE@EXAMPLE.COM", currentPassword: "p" })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("SAME_EMAIL");
    expect(getUserWithPassword).not.toHaveBeenCalled();
  });
});

// ─── NO_PASSWORD safeguard ────────────────────────────────────────
describe("NO_PASSWORD (account in inconsistent state)", () => {
  it("getUserWithPassword returns null → 400 NO_PASSWORD", async () => {
    getUserWithPassword.mockResolvedValueOnce(null);
    const res = await POST(
      makeReq({ newEmail: "new@example.com", currentPassword: "p" })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("NO_PASSWORD");
  });

  it("getUserWithPassword returns user with password=undefined → 400 NO_PASSWORD (no comparePassword crash)", async () => {
    getUserWithPassword.mockResolvedValueOnce(userWithPwd({ password: undefined }));
    const res = await POST(
      makeReq({ newEmail: "new@example.com", currentPassword: "p" })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("NO_PASSWORD");
  });
});

// ─── Password re-prompt (ATO defence) ─────────────────────────────
describe("Password re-prompt", () => {
  it("comparePassword rejects → 401 INVALID_PASSWORD; no token issued", async () => {
    const u = userWithPwd();
    u.comparePassword = vi.fn().mockResolvedValue(false);
    getUserWithPassword.mockResolvedValueOnce(u);

    const res = await POST(
      makeReq({ newEmail: "new@example.com", currentPassword: "wrong-pw" })
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("INVALID_PASSWORD");
    expect(u.save).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("comparePassword called with the submitted password (not a constant)", async () => {
    const u = userWithPwd();
    getUserWithPassword.mockResolvedValueOnce(u);
    await POST(
      makeReq({ newEmail: "new@example.com", currentPassword: "MyP@ss123" })
    );
    expect(u.comparePassword).toHaveBeenCalledWith("MyP@ss123");
  });
});

// ─── Email-enumeration prevention ─────────────────────────────────
describe("Email-enumeration prevention", () => {
  it("newEmail already registered → returns SAME generic success message (not 'taken'), NO token issued, NO emails sent", async () => {
    getUserByEmail.mockResolvedValueOnce({
      _id: "OTHER",
      email: "new@example.com",
    });
    const u = userWithPwd();
    getUserWithPassword.mockResolvedValueOnce(u);

    const res = await POST(
      makeReq({ newEmail: "new@example.com", currentPassword: "p" })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe(
      "If that address is available, a verification link has been sent to it."
    );
    expect(u.save).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

// ─── Happy path: token issuance + two emails ──────────────────────
describe("Happy path — token issuance + two emails", () => {
  it("stores SHA-256 hash of raw token (NOT raw); sets 1hr TTL; sends to NEW + OLD addresses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-08T12:00:00.000Z"));

    const u = userWithPwd();
    getUserWithPassword.mockResolvedValueOnce(u);

    const res = await POST(
      makeReq({ newEmail: "new@example.com", currentPassword: "p" })
    );
    expect(res.status).toBe(200);

    // Token storage: hash, NOT raw
    expect(u.pendingEmail).toBe("new@example.com");
    expect(u.pendingEmailToken).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
    expect(u.pendingEmailExpiry).toBeInstanceOf(Date);
    expect(u.pendingEmailExpiry?.getTime()).toBe(
      new Date("2026-06-08T13:00:00.000Z").getTime()
    );
    expect(u.save).toHaveBeenCalledTimes(1);

    // Two emails: new addr + old addr
    expect(sendEmail).toHaveBeenCalledTimes(2);
    const toAddresses = sendEmail.mock.calls.map((c) => c[0].to);
    expect(toAddresses).toContain("new@example.com");
    expect(toAddresses).toContain("alice@example.com");

    vi.useRealTimers();
  });

  it("verification link contains the RAW token (not the hashed one)", async () => {
    const u = userWithPwd();
    getUserWithPassword.mockResolvedValueOnce(u);

    await POST(
      makeReq({ newEmail: "new@example.com", currentPassword: "p" })
    );

    const newAddrCall = sendEmail.mock.calls.find(
      (c) => c[0].to === "new@example.com"
    );
    expect(newAddrCall).toBeTruthy();
    const html = newAddrCall![0].html as string;
    // Raw token is 64-char hex too (32 bytes hex-encoded); but it must NOT
    // equal the stored hash
    const linkMatch = html.match(/token=([a-f0-9]+)/);
    expect(linkMatch).toBeTruthy();
    expect(linkMatch![1].length).toBe(64);
    expect(linkMatch![1]).not.toBe(u.pendingEmailToken);
  });

  it("security-alert email goes to the OLD address with the proposed new address in body", async () => {
    const u = userWithPwd();
    getUserWithPassword.mockResolvedValueOnce(u);

    await POST(
      makeReq({ newEmail: "new@example.com", currentPassword: "p" })
    );

    const oldAddrCall = sendEmail.mock.calls.find(
      (c) => c[0].to === "alice@example.com"
    );
    expect(oldAddrCall).toBeTruthy();
    const html = oldAddrCall![0].html as string;
    expect(html).toContain("new@example.com");
  });
});

// ─── Outer error handling ─────────────────────────────────────────
describe("Outer error handling", () => {
  it("getUserWithPassword throw → 500 INTERNAL_ERROR (no DB internals leaked)", async () => {
    getUserWithPassword.mockRejectedValueOnce(new Error("DB exploded"));
    const res = await POST(
      makeReq({ newEmail: "new@example.com", currentPassword: "p" })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL_ERROR");
  });

  it("sendEmail throw → 500 INTERNAL_ERROR (mailserver failure caught)", async () => {
    const u = userWithPwd();
    getUserWithPassword.mockResolvedValueOnce(u);
    sendEmail.mockRejectedValueOnce(new Error("SMTP down"));

    const res = await POST(
      makeReq({ newEmail: "new@example.com", currentPassword: "p" })
    );
    expect(res.status).toBe(500);
  });
});
