/**
 * Tests for `app/api/user/settings/verify-email-change/route.ts`
 * (slice 7gd, part 2). The confirm half of the email-change flow.
 *
 * This handler is reached by the link emailed to the NEW address.
 * Outcomes are surfaced via redirects to `/login?email_change=...`
 * (the front-end branches on the query flag) — never via JSON, so
 * the user is signed out and lands on the login page in every case.
 *
 * Critical security invariants pinned here:
 *  - **Token shape validation FIRST** — missing / non-string /
 *    length !== 64 → redirect `?email_change=invalid` (rejects
 *    obviously-tampered tokens before any DB lookup)
 *  - **Token resolved by SHA-256 HASH lookup** — the raw token
 *    from the URL is sha256'd and compared against the stored
 *    hash; the raw token is never stored anywhere
 *  - **Unknown token → invalid redirect** — protects against
 *    expired-token reuse + tokens forged with random hex
 *  - **TTL-window race protection** — if a different account
 *    registered the pending email in the meantime,
 *    findUserByEmailExcluding finds the conflict, the handler
 *    CLEARS the pending fields on this user, and redirects
 *    `?email_change=taken`. This is critical: without the clear,
 *    the user record retains a stale pendingEmail pointing at
 *    someone else's address.
 *  - **Email swap atomicity** — the new email is applied AND all
 *    pending fields are cleared AND sessionInvalidatedAt is set
 *    AND save() is awaited, in a single save() call
 *  - **Session invalidation** — sessionInvalidatedAt is set on
 *    success (forces re-login on the new address; this is what
 *    prevents a session token issued with the old address from
 *    continuing to function)
 *  - **Old-address notification failure swallowed** — the .catch()
 *    on sendEmail means a mailserver hiccup must not roll back
 *    the actual change; the audit-trail email is best-effort
 *  - **Catastrophic throw → redirect `?email_change=error`** —
 *    never a 500 with stack details (token endpoint is publicly
 *    reachable from email links)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";

const findUserByEmailExcluding = vi.hoisted(() => vi.fn());
const findUserByPendingEmailToken = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({
  findUserByEmailExcluding,
  findUserByPendingEmailToken,
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

import { GET } from "@/app/api/user/settings/verify-email-change/route";

const APP_URL = "https://app.anutech.in";

function makeReq(qs = "") {
  const url = qs
    ? `${APP_URL}/api/user/settings/verify-email-change?${qs}`
    : `${APP_URL}/api/user/settings/verify-email-change`;
  return new NextRequest(url, { method: "GET" });
}

function sha256(s: string) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function userRec(overrides: Record<string, unknown> = {}) {
  return {
    _id: "U1",
    email: "alice@example.com",
    firstName: "Alice",
    lastName: "Anderson",
    pendingEmail: "new@example.com",
    pendingEmailToken: "stored-hash",
    pendingEmailExpiry: new Date(Date.now() + 60 * 60 * 1000),
    sessionInvalidatedAt: undefined,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const VALID_RAW = "a".repeat(64); // 64 hex chars
const VALID_RAW_HASH = sha256(VALID_RAW);

beforeEach(() => {
  findUserByPendingEmailToken.mockReset();
  findUserByEmailExcluding.mockReset().mockResolvedValue(null);
  sendEmail.mockReset().mockResolvedValue(undefined);
});

// ─── Token-shape gate ─────────────────────────────────────────────
describe("Token shape gate (rejects without DB lookup)", () => {
  it("missing token → redirect ?email_change=invalid", async () => {
    const res = await GET(makeReq());
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toContain("email_change=invalid");
    expect(findUserByPendingEmailToken).not.toHaveBeenCalled();
  });

  it("token of length !== 64 → invalid redirect (no DB lookup)", async () => {
    const res = await GET(makeReq("token=tooshort"));
    expect(res.headers.get("location")).toContain("email_change=invalid");
    expect(findUserByPendingEmailToken).not.toHaveBeenCalled();
  });

  it("64-char token IS looked up (length gate passed)", async () => {
    findUserByPendingEmailToken.mockResolvedValueOnce(null);
    await GET(makeReq(`token=${VALID_RAW}`));
    expect(findUserByPendingEmailToken).toHaveBeenCalled();
  });
});

// ─── Token resolution via SHA-256 hash ────────────────────────────
describe("Token resolution", () => {
  it("findUserByPendingEmailToken called with sha256(rawToken) — NOT raw", async () => {
    findUserByPendingEmailToken.mockResolvedValueOnce(null);
    await GET(makeReq(`token=${VALID_RAW}`));
    expect(findUserByPendingEmailToken).toHaveBeenCalledWith(VALID_RAW_HASH);
    expect(findUserByPendingEmailToken).not.toHaveBeenCalledWith(VALID_RAW);
  });

  it("no user found → invalid redirect (expired / forged / reused token)", async () => {
    findUserByPendingEmailToken.mockResolvedValueOnce(null);
    const res = await GET(makeReq(`token=${VALID_RAW}`));
    expect(res.headers.get("location")).toContain("email_change=invalid");
    expect(findUserByEmailExcluding).not.toHaveBeenCalled();
  });
});

// ─── TTL-window race: new email got taken by someone else ────────
describe("TTL-window race protection", () => {
  it("conflict → clears pending fields + saves; redirect ?email_change=taken", async () => {
    const u = userRec();
    findUserByPendingEmailToken.mockResolvedValueOnce(u);
    findUserByEmailExcluding.mockResolvedValueOnce({
      _id: "OTHER",
      email: "new@example.com",
    });

    const res = await GET(makeReq(`token=${VALID_RAW}`));
    expect(res.headers.get("location")).toContain("email_change=taken");
    // Pending fields cleared so user record doesn't retain stale state
    expect(u.pendingEmail).toBeUndefined();
    expect(u.pendingEmailToken).toBeUndefined();
    expect(u.pendingEmailExpiry).toBeUndefined();
    expect(u.save).toHaveBeenCalledTimes(1);
    // Email NOT swapped
    expect(u.email).toBe("alice@example.com");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("findUserByEmailExcluding called with newEmail + this user._id (excludes self)", async () => {
    const u = userRec();
    findUserByPendingEmailToken.mockResolvedValueOnce(u);
    await GET(makeReq(`token=${VALID_RAW}`));
    expect(findUserByEmailExcluding).toHaveBeenCalledWith(
      "new@example.com",
      "U1"
    );
  });
});

// ─── Happy path: atomic swap + session invalidation ──────────────
describe("Happy path — atomic swap + session invalidation", () => {
  it("swaps email, clears pending fields, sets sessionInvalidatedAt, ONE save() call", async () => {
    const u = userRec();
    findUserByPendingEmailToken.mockResolvedValueOnce(u);

    const res = await GET(makeReq(`token=${VALID_RAW}`));
    expect(res.headers.get("location")).toContain("email_change=success");
    expect(u.email).toBe("new@example.com");
    expect(u.pendingEmail).toBeUndefined();
    expect(u.pendingEmailToken).toBeUndefined();
    expect(u.pendingEmailExpiry).toBeUndefined();
    expect(u.sessionInvalidatedAt).toBeInstanceOf(Date);
    expect(u.save).toHaveBeenCalledTimes(1);
  });

  it("notification email sent to OLD address (audit-trail)", async () => {
    const u = userRec();
    findUserByPendingEmailToken.mockResolvedValueOnce(u);

    await GET(makeReq(`token=${VALID_RAW}`));
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].to).toBe("alice@example.com");
    // body mentions new address
    expect(sendEmail.mock.calls[0][0].html).toContain("new@example.com");
  });

  it("old-address notification failure SWALLOWED — change still succeeds", async () => {
    const u = userRec();
    findUserByPendingEmailToken.mockResolvedValueOnce(u);
    sendEmail.mockRejectedValueOnce(new Error("SMTP timeout"));

    const res = await GET(makeReq(`token=${VALID_RAW}`));
    expect(res.headers.get("location")).toContain("email_change=success");
    expect(u.email).toBe("new@example.com");
  });
});

// ─── Catastrophic throw ──────────────────────────────────────────
describe("Catastrophic throw → error redirect (never 500 JSON)", () => {
  it("findUserByPendingEmailToken throws → redirect ?email_change=error", async () => {
    findUserByPendingEmailToken.mockRejectedValueOnce(new Error("DB down"));
    const res = await GET(makeReq(`token=${VALID_RAW}`));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toContain("email_change=error");
  });

  it("user.save throws on success path → error redirect", async () => {
    const u = userRec();
    u.save = vi.fn().mockRejectedValue(new Error("Mongo write conflict"));
    findUserByPendingEmailToken.mockResolvedValueOnce(u);

    const res = await GET(makeReq(`token=${VALID_RAW}`));
    expect(res.headers.get("location")).toContain("email_change=error");
  });
});
