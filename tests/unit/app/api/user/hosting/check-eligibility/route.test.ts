/**
 * Tests for `app/api/user/hosting/check-eligibility/route.ts`
 * (slice 7hf, part 2). Customer-facing trial-eligibility gate.
 * Both GET and POST share a `performEligibilityCheck` helper —
 * pinned across both verbs to guarantee parity.
 *
 * Threat model:
 *  - **Cross-user data leak**: domain-history queries must be
 *    scoped to userId so a customer can't probe whether other
 *    customers' domains exist by passing them to ?domainName
 *  - **One-trial-per-user**: must check BOTH the hosting
 *    collection AND the order history (covers the case where the
 *    hosting row was deleted but the order is still around — the
 *    customer should still be locked out from a second trial)
 *
 * Pins:
 *  - Auth → 401 on GET AND POST
 *  - **Three eligibility checks in order**:
 *      1. userHasAnyHosting(userId) → if true, ineligible
 *         ("You already have an active or previous hosting
 *         account.") — blocks both active hostings and
 *         terminated-but-still-on-record hostings
 *      2. findPriorHostingOrderForUser(userId, email) → if a
 *         prior order exists → ineligible ("Your account is
 *         associated with a previous hosting purchase.") —
 *         second layer of trial gating via order history
 *      3. If domainName provided: findUserHosting(userId,
 *         {domainName}) → if hit → ineligible ("This domain
 *         already has hosting under your account.")
 *  - **All three short-circuit on hit** (rejecter returns from
 *    helper; later checks NOT run)
 *  - Eligible path → { eligible: true } (no extra fields)
 *  - GET: ?domainName lowercased before check; missing → null
 *    (domain-conflict skipped)
 *  - POST: zod body schema; domainName optional (lowercased
 *    + trimmed)
 *  - Outer catch → 500 'Internal server error' on either verb
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const findPriorHostingOrderForUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({ findPriorHostingOrderForUser }));

const findUserHosting = vi.hoisted(() => vi.fn());
const userHasAnyHosting = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hostings", () => ({
  findUserHosting,
  userHasAnyHosting,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET, POST } from "@/app/api/user/hosting/check-eligibility/route";

function makeGetReq(qs = "") {
  const url = qs
    ? `https://example.com/api/user/hosting/check-eligibility?${qs}`
    : "https://example.com/api/user/hosting/check-eligibility";
  return new NextRequest(url, { method: "GET" });
}

function makePostReq(body: unknown) {
  return new NextRequest(
    "https://example.com/api/user/hosting/check-eligibility",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }
  );
}

const user = { _id: "U1", email: "alice@example.com" };

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(user);
  findPriorHostingOrderForUser.mockReset().mockResolvedValue(null);
  findUserHosting.mockReset().mockResolvedValue(null);
  userHasAnyHosting.mockReset().mockResolvedValue(false);
});

// ─── Auth gate (both verbs) ──────────────────────────────────────
describe("Auth gate — both verbs", () => {
  it("GET no user → 401", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeGetReq());
    expect(res.status).toBe(401);
    expect(userHasAnyHosting).not.toHaveBeenCalled();
  });

  it("POST no user → 401", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makePostReq({ domainName: "x.com" }));
    expect(res.status).toBe(401);
    expect(userHasAnyHosting).not.toHaveBeenCalled();
  });
});

// ─── userHasAnyHosting gate (CHECK 1) ────────────────────────────
describe("Check 1 — userHasAnyHosting", () => {
  it("hosting exists → ineligible 'You already have...'; NO order check, NO domain check", async () => {
    userHasAnyHosting.mockResolvedValueOnce(true);
    const res = await GET(makeGetReq("domainName=test.com"));
    const body = await res.json();
    expect(body).toEqual({
      eligible: false,
      reason: "You already have an active or previous hosting account.",
    });
    // Short-circuits: subsequent checks NOT called
    expect(findPriorHostingOrderForUser).not.toHaveBeenCalled();
    expect(findUserHosting).not.toHaveBeenCalled();
  });

  it("userHasAnyHosting called with String(user._id)", async () => {
    userHasAnyHosting.mockResolvedValueOnce(true);
    await GET(makeGetReq());
    expect(userHasAnyHosting).toHaveBeenCalledWith("U1");
  });
});

// ─── findPriorHostingOrderForUser gate (CHECK 2) ─────────────────
describe("Check 2 — findPriorHostingOrderForUser", () => {
  it("prior order exists → ineligible 'previous hosting purchase'; NO domain check", async () => {
    userHasAnyHosting.mockResolvedValueOnce(false);
    findPriorHostingOrderForUser.mockResolvedValueOnce({ orderId: "ORD-OLD" });

    const res = await GET(makeGetReq("domainName=test.com"));
    const body = await res.json();
    expect(body).toEqual({
      eligible: false,
      reason: "Your account is associated with a previous hosting purchase.",
    });
    expect(findUserHosting).not.toHaveBeenCalled();
  });

  it("findPriorHostingOrderForUser called with (user._id, email)", async () => {
    findPriorHostingOrderForUser.mockResolvedValueOnce(null);
    await GET(makeGetReq());
    expect(findPriorHostingOrderForUser).toHaveBeenCalledWith(
      "U1",
      "alice@example.com"
    );
  });
});

// ─── findUserHosting gate (CHECK 3) ──────────────────────────────
describe("Check 3 — domain-conflict (user-scoped)", () => {
  it("domain already has hosting under THIS user → ineligible 'This domain already has hosting'", async () => {
    findUserHosting.mockResolvedValueOnce({
      _id: "H1",
      domainName: "test.com",
    });
    const res = await GET(makeGetReq("domainName=test.com"));
    const body = await res.json();
    expect(body).toEqual({
      eligible: false,
      reason: "This domain already has hosting under your account.",
    });
  });

  it("findUserHosting called with (user._id, {domainName}) — user-scoped, NOT global lookup", async () => {
    findUserHosting.mockResolvedValueOnce(null);
    await GET(makeGetReq("domainName=cross-tenant.com"));
    expect(findUserHosting).toHaveBeenCalledWith("U1", {
      domainName: "cross-tenant.com",
    });
  });

  it("no domainName → domain check SKIPPED entirely", async () => {
    await GET(makeGetReq());
    expect(findUserHosting).not.toHaveBeenCalled();
  });
});

// ─── Eligible path ───────────────────────────────────────────────
describe("Eligible path", () => {
  it("all 3 checks pass → { eligible: true } only (no extra fields)", async () => {
    const res = await GET(makeGetReq("domainName=fresh.com"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ eligible: true });
  });
});

// ─── GET-specific: query param lowercased ────────────────────────
describe("GET — ?domainName lowercased before check", () => {
  it("?domainName=ALICE.COM → lookup uses 'alice.com'", async () => {
    await GET(makeGetReq("domainName=ALICE.COM"));
    expect(findUserHosting).toHaveBeenCalledWith("U1", {
      domainName: "alice.com",
    });
  });
});

// ─── POST-specific: zod schema ───────────────────────────────────
describe("POST — zod body schema", () => {
  it("invalid domainName format (too short) → 400", async () => {
    const res = await POST(makePostReq({ domainName: "x" }));
    expect(res.status).toBe(400);
  });

  it("domainName omitted → eligible if other checks pass (optional field)", async () => {
    const res = await POST(makePostReq({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ eligible: true });
    expect(findUserHosting).not.toHaveBeenCalled();
  });

  it("POST mirror of GET — same eligibility shape on same inputs", async () => {
    userHasAnyHosting.mockResolvedValueOnce(true);
    const res = await POST(makePostReq({ domainName: "x.com" }));
    const body = await res.json();
    expect(body).toEqual({
      eligible: false,
      reason: "You already have an active or previous hosting account.",
    });
  });

  it("POST lowercases + trims domainName via zod schema", async () => {
    await POST(makePostReq({ domainName: "  ALICE.COM  " }));
    expect(findUserHosting).toHaveBeenCalledWith("U1", {
      domainName: "alice.com",
    });
  });
});

// ─── Outer catch ─────────────────────────────────────────────────
describe("Outer catch (both verbs)", () => {
  it("GET userHasAnyHosting throw → 500 'Internal server error'", async () => {
    userHasAnyHosting.mockRejectedValueOnce(new Error("Mongo down"));
    const res = await GET(makeGetReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
  });

  it("POST userHasAnyHosting throw → 500 'Internal server error'", async () => {
    userHasAnyHosting.mockRejectedValueOnce(new Error("Mongo down"));
    const res = await POST(makePostReq({ domainName: "x.com" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
  });
});
