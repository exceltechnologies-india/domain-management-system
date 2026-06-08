/**
 * Tests for `app/api/user/domains/watch/route.ts` (slice 7gg).
 * Customer domain-watch list — GET (list) + POST (add) + DELETE
 * (remove). All three operations are user-scoped: queries pass
 * `user._id` so the caller can never see or mutate someone else's
 * watches.
 *
 * Pins:
 *  - Auth gate FIRST on GET / POST / DELETE → 401 UNAUTHORIZED
 *  - GET: passes user._id (as String) to listWatchesForUser;
 *    response shape `{ watches }`
 *  - POST: zod schema (domainName trim+lowercase, 3-253 chars);
 *    bad → 400 VALIDATION_ERROR
 *  - **Per-user cap = 20**: countWatchesForUser returning ≥ 20 →
 *    400 WATCH_LIMIT_EXCEEDED; upsert NOT called (anti-abuse so
 *    one user can't bloat the collection)
 *  - POST happy path: upsertUserWatch(user._id, normalised
 *    domainName) → 201 with `{ watch }`
 *  - **E11000 (duplicate-key) → 409 ALREADY_WATCHING** (race-safe;
 *    the unique index is the source of truth, the count check is
 *    advisory only)
 *  - Other POST throw → 500 SERVER_ERROR
 *  - DELETE: domain query param trimmed + lowercased
 *  - DELETE: missing ?domain → 400 MISSING_DOMAIN
 *  - DELETE: removeUserWatch returning falsy → 404 NOT_FOUND
 *    (this is the IDOR check — the service scopes by user._id;
 *    a non-owner gets 404, not 200)
 *  - GET / DELETE throw → 500 SERVER_ERROR
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const listWatchesForUser = vi.hoisted(() => vi.fn());
const countWatchesForUser = vi.hoisted(() => vi.fn());
const upsertUserWatch = vi.hoisted(() => vi.fn());
const removeUserWatch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/domain-watches", () => ({
  listWatchesForUser,
  countWatchesForUser,
  upsertUserWatch,
  removeUserWatch,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET, POST, DELETE } from "@/app/api/user/domains/watch/route";

function makeGetReq() {
  return new NextRequest("https://example.com/api/user/domains/watch", {
    method: "GET",
  });
}

function makePostReq(body: unknown) {
  return new NextRequest("https://example.com/api/user/domains/watch", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function makeDeleteReq(qs = "") {
  const url = qs
    ? `https://example.com/api/user/domains/watch?${qs}`
    : "https://example.com/api/user/domains/watch";
  return new NextRequest(url, { method: "DELETE" });
}

const user = { _id: "U1", email: "alice@example.com" };

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(user);
  listWatchesForUser.mockReset();
  countWatchesForUser.mockReset();
  upsertUserWatch.mockReset();
  removeUserWatch.mockReset();
});

// ─── GET ──────────────────────────────────────────────────────────
describe("GET — auth gate + list", () => {
  it("no user → 401 UNAUTHORIZED", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeGetReq());
    expect(res.status).toBe(401);
    expect(listWatchesForUser).not.toHaveBeenCalled();
  });

  it("user → listWatchesForUser called with String(user._id); response shape { watches }", async () => {
    listWatchesForUser.mockResolvedValueOnce([
      { domainName: "a.com" },
      { domainName: "b.com" },
    ]);
    const res = await GET(makeGetReq());
    expect(res.status).toBe(200);
    expect(listWatchesForUser).toHaveBeenCalledWith("U1");
    const body = await res.json();
    expect(body.watches).toHaveLength(2);
  });

  it("service throw → 500 SERVER_ERROR", async () => {
    listWatchesForUser.mockRejectedValueOnce(new Error("DB down"));
    const res = await GET(makeGetReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("SERVER_ERROR");
  });
});

// ─── POST ─────────────────────────────────────────────────────────
describe("POST — auth gate", () => {
  it("no user → 401; no count/upsert", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makePostReq({ domainName: "x.com" }));
    expect(res.status).toBe(401);
    expect(countWatchesForUser).not.toHaveBeenCalled();
    expect(upsertUserWatch).not.toHaveBeenCalled();
  });
});

describe("POST — body validation", () => {
  it("missing domainName → 400 VALIDATION_ERROR", async () => {
    const res = await POST(makePostReq({}));
    expect(res.status).toBe(400);
  });

  it("too-short domainName (< 3 chars) → 400", async () => {
    const res = await POST(makePostReq({ domainName: "a" }));
    expect(res.status).toBe(400);
  });

  it("too-long domainName (> 253) → 400", async () => {
    const res = await POST(
      makePostReq({ domainName: "a".repeat(254) + ".com" })
    );
    expect(res.status).toBe(400);
  });
});

describe("POST — per-user cap (anti-abuse)", () => {
  it("count >= 20 → 400 WATCH_LIMIT_EXCEEDED; upsert NOT called", async () => {
    countWatchesForUser.mockResolvedValueOnce(20);
    const res = await POST(makePostReq({ domainName: "new-watch.com" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("WATCH_LIMIT_EXCEEDED");
    expect(upsertUserWatch).not.toHaveBeenCalled();
  });

  it("count === 19 → 201 (cap is strict-greater-equal at 20)", async () => {
    countWatchesForUser.mockResolvedValueOnce(19);
    upsertUserWatch.mockResolvedValueOnce({ domainName: "new-watch.com" });
    const res = await POST(makePostReq({ domainName: "new-watch.com" }));
    expect(res.status).toBe(201);
    expect(upsertUserWatch).toHaveBeenCalled();
  });
});

describe("POST — happy path", () => {
  it("calls upsertUserWatch(user._id, normalised domain); responds 201 { watch }", async () => {
    countWatchesForUser.mockResolvedValueOnce(5);
    upsertUserWatch.mockResolvedValueOnce({
      _id: "W1",
      domainName: "happy.com",
    });
    const res = await POST(makePostReq({ domainName: "  HAPPY.COM  " }));
    expect(res.status).toBe(201);
    expect(upsertUserWatch).toHaveBeenCalledWith("U1", "happy.com");
    const body = await res.json();
    expect(body.watch._id).toBe("W1");
  });
});

describe("POST — duplicate-key race", () => {
  it("E11000 (code 11000) thrown by upsert → 409 ALREADY_WATCHING (race-safe)", async () => {
    countWatchesForUser.mockResolvedValueOnce(5);
    const err = Object.assign(new Error("dup key"), { code: 11000 });
    upsertUserWatch.mockRejectedValueOnce(err);
    const res = await POST(makePostReq({ domainName: "dup.com" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("ALREADY_WATCHING");
  });

  it("non-E11000 throw → 500 SERVER_ERROR", async () => {
    countWatchesForUser.mockResolvedValueOnce(5);
    upsertUserWatch.mockRejectedValueOnce(new Error("oops"));
    const res = await POST(makePostReq({ domainName: "x.com" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("SERVER_ERROR");
  });

  it("countWatchesForUser throw → 500", async () => {
    countWatchesForUser.mockRejectedValueOnce(new Error("DB down"));
    const res = await POST(makePostReq({ domainName: "x.com" }));
    expect(res.status).toBe(500);
  });
});

// ─── DELETE ───────────────────────────────────────────────────────
describe("DELETE — auth gate", () => {
  it("no user → 401", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await DELETE(makeDeleteReq("domain=x.com"));
    expect(res.status).toBe(401);
    expect(removeUserWatch).not.toHaveBeenCalled();
  });
});

describe("DELETE — missing param", () => {
  it("no ?domain → 400 MISSING_DOMAIN", async () => {
    const res = await DELETE(makeDeleteReq());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("MISSING_DOMAIN");
  });

  it("whitespace-only ?domain (trim → '') → 400 MISSING_DOMAIN", async () => {
    const res = await DELETE(makeDeleteReq("domain=%20%20%20"));
    expect(res.status).toBe(400);
  });
});

describe("DELETE — happy path + IDOR scope", () => {
  it("normalises ?domain to lowercase + trimmed; calls removeUserWatch(user._id, domain)", async () => {
    removeUserWatch.mockResolvedValueOnce(true);
    await DELETE(makeDeleteReq("domain=%20EVIL.COM%20"));
    expect(removeUserWatch).toHaveBeenCalledWith("U1", "evil.com");
  });

  it("service scoped by user._id → not-owner / not-found returns 404 (NOT 200)", async () => {
    removeUserWatch.mockResolvedValueOnce(false);
    const res = await DELETE(makeDeleteReq("domain=other-users-domain.com"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("happy path → 200 { success: true }", async () => {
    removeUserWatch.mockResolvedValueOnce(true);
    const res = await DELETE(makeDeleteReq("domain=mine.com"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});

describe("DELETE — error handling", () => {
  it("removeUserWatch throw → 500 SERVER_ERROR", async () => {
    removeUserWatch.mockRejectedValueOnce(new Error("DB down"));
    const res = await DELETE(makeDeleteReq("domain=x.com"));
    expect(res.status).toBe(500);
  });
});
