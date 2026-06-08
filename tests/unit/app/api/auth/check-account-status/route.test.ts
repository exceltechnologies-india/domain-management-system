/**
 * Tests for `app/api/auth/check-account-status/route.ts` (slice 7gm,
 * part 4). Public, unauthenticated endpoint that the login UI calls
 * before submitting credentials to decide which form to show
 * (Sign in / Sign up / "Your account is deactivated").
 *
 * **Security policy note:** This is a deliberate email-enumeration
 * endpoint. Returning whether an email exists is the product
 * decision (better UX for guests vs returning users). Tests pin
 * the current contract so a future "anti-enumeration" refactor
 * gets flagged before merge.
 *
 * Pins:
 *  - zod email schema (Schemas.email = trimmed + lowercased + max 254)
 *  - Bad email → 400 VALIDATION_ERROR; NO DB lookup
 *  - Email normalized (lowercased + trimmed) BEFORE getUserByEmail
 *    via Schemas.email
 *  - User NOT found → `{ exists:false, isActive:false }` (NO role
 *    field — role exposure is gated on existence)
 *  - User found → `{ exists:true, isActive, isDeactivated: !isActive,
 *    role }` (role IS returned — pinned so an admin-account-discovery
 *    audit catches this on the next refactor)
 *  - Both responses are status 200 — never 404 (front-end uses the
 *    JSON shape, not status)
 *  - Outer catch → 500 'Internal server error' (NO stack leak)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserByEmail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserByEmail }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/auth/check-account-status/route";

function makeReq(body: unknown) {
  return new NextRequest("https://example.com/api/auth/check-account-status", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  getUserByEmail.mockReset();
});

// ─── Body validation ─────────────────────────────────────────────
describe("Body validation", () => {
  it("missing email → 400 VALIDATION_ERROR; NO DB lookup", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    expect(getUserByEmail).not.toHaveBeenCalled();
  });

  it("invalid email format → 400; NO DB lookup", async () => {
    const res = await POST(makeReq({ email: "not-an-email" }));
    expect(res.status).toBe(400);
    expect(getUserByEmail).not.toHaveBeenCalled();
  });

  it("oversize email (> 254 chars) → 400", async () => {
    const big = "a".repeat(250) + "@x.com";
    const res = await POST(makeReq({ email: big }));
    expect(res.status).toBe(400);
  });
});

// ─── Email normalisation ─────────────────────────────────────────
describe("Email normalisation (Schemas.email lowercases)", () => {
  it("'ALICE@EXAMPLE.COM' → getUserByEmail called with 'alice@example.com'", async () => {
    getUserByEmail.mockResolvedValueOnce(null);
    await POST(makeReq({ email: "ALICE@EXAMPLE.COM" }));
    expect(getUserByEmail).toHaveBeenCalledWith("alice@example.com");
  });

  it("emails with leading/trailing whitespace are REJECTED by .email() before .trim() runs → 400", async () => {
    const res = await POST(makeReq({ email: "  alice@example.com  " }));
    expect(res.status).toBe(400);
    // pinned because Zod runs .email() before transforms; if the schema is
    // ever reshaped to trim-first this test fails and forces a review
    expect(getUserByEmail).not.toHaveBeenCalled();
  });
});

// ─── Not-found response shape ────────────────────────────────────
describe("User not found", () => {
  it("returns { exists:false, isActive:false } — NO role field", async () => {
    getUserByEmail.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ email: "ghost@example.com" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ exists: false, isActive: false });
    expect(body).not.toHaveProperty("role");
    expect(body).not.toHaveProperty("isDeactivated");
  });
});

// ─── Found response shape (deliberate enumeration contract) ──────
describe("User found — deliberate enumeration contract", () => {
  it("active user → exists/isActive/isDeactivated/role all present", async () => {
    getUserByEmail.mockResolvedValueOnce({
      _id: "U1",
      email: "alice@example.com",
      isActive: true,
      role: "user",
    });
    const res = await POST(makeReq({ email: "alice@example.com" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      exists: true,
      isActive: true,
      isDeactivated: false,
      role: "user",
    });
  });

  it("deactivated user → isDeactivated:true", async () => {
    getUserByEmail.mockResolvedValueOnce({
      _id: "U2",
      email: "dead@example.com",
      isActive: false,
      role: "user",
    });
    const res = await POST(makeReq({ email: "dead@example.com" }));
    const body = await res.json();
    expect(body).toEqual({
      exists: true,
      isActive: false,
      isDeactivated: true,
      role: "user",
    });
  });

  it("**admin role IS exposed** (pinned so a future audit catches this)", async () => {
    getUserByEmail.mockResolvedValueOnce({
      _id: "ADMIN1",
      email: "admin@example.com",
      isActive: true,
      role: "admin",
    });
    const res = await POST(makeReq({ email: "admin@example.com" }));
    const body = await res.json();
    expect(body.role).toBe("admin");
    // If this test ever fails because the field disappears, that's a
    // policy change that needs review — admin-role discoverability is
    // a known enumeration vector but currently intentional for the
    // login UI's role-aware redirect.
  });

  it("status is 200 for both found AND not-found (front-end branches on JSON, not status)", async () => {
    getUserByEmail.mockResolvedValueOnce(null);
    let res = await POST(makeReq({ email: "a@example.com" }));
    expect(res.status).toBe(200);

    getUserByEmail.mockResolvedValueOnce({
      _id: "U1",
      isActive: true,
      role: "user",
    });
    res = await POST(makeReq({ email: "b@example.com" }));
    expect(res.status).toBe(200);
  });
});

// ─── Outer catch ─────────────────────────────────────────────────
describe("Outer catch", () => {
  it("getUserByEmail throw → 500 'Internal server error' (no stack leak)", async () => {
    getUserByEmail.mockRejectedValueOnce(new Error("DB blew up"));
    const res = await POST(makeReq({ email: "a@example.com" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
    expect(body.error).not.toContain("DB blew up");
  });
});
