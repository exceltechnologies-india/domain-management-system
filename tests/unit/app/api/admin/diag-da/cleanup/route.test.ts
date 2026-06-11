/**
 * Tests for `app/api/admin/diag-da/cleanup/route.ts` (slice 7hi,
 * part 2). Bulk DA-user delete tool. Up to 100 usernames per
 * request; uses the same typed-outcome dispatch as 7gu's change-
 * package, but tailored for "delete with idempotent semantics".
 *
 * Pins:
 *  - Admin gate → 403 FORBIDDEN
 *  - zod schema: usernames array of strings (trim, 1-100 chars
 *    per name), min:1, **max:100 anti-DoS cap** (boundary 100
 *    accepted, 101 rejected)
 *  - connectDB AFTER auth + validation (no DB hit on bad reqs)
 *  - **Typed-outcome dispatch — 4 branches**:
 *      - 'deleted' → success:true, outcome:'deleted'
 *      - 'user_not_found' → success:true, outcome:'user_not_found'
 *        (coalesced with deleted — operationally the same: the
 *        user is gone)
 *      - 'da_unreachable' → success:false, outcome surfaced,
 *        error 'DA temporarily unreachable — try again'
 *      - 'hard_failure' → success:false, outcome surfaced, error
 *        'Delete failed — see server logs'
 *  - **Per-username failure isolation**: a 'da_unreachable' on
 *    one username does NOT abort the loop (others continue)
 *  - Outer catch → 500 CLEANUP_FAILED with error.message
 *    (matches 7gr/7gt family quirk)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const isAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { isAdmin },
}));

const daDeleteUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/integrations/directadmin", () => ({
  deleteUser: daDeleteUser,
}));

const connectDB = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/mongodb", () => ({ default: connectDB }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/admin/diag-da/cleanup/route";

function makeReq(body: unknown) {
  return new NextRequest("https://example.com/api/admin/diag-da/cleanup", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  isAdmin.mockReset();
  daDeleteUser.mockReset();
  connectDB.mockClear().mockResolvedValue(undefined);
});

describe("Admin gate", () => {
  it("non-admin → 403; NO validation, NO DB, NO DA call", async () => {
    isAdmin.mockResolvedValueOnce(false);
    const res = await POST(makeReq({ usernames: ["u1"] }));
    expect(res.status).toBe(403);
    expect(connectDB).not.toHaveBeenCalled();
    expect(daDeleteUser).not.toHaveBeenCalled();
  });
});

describe("Body validation (100-cap anti-DoS)", () => {
  beforeEach(() => {
    isAdmin.mockResolvedValue(true);
  });

  it("missing usernames → 400", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    expect(daDeleteUser).not.toHaveBeenCalled();
  });

  it("empty usernames → 400 (min:1)", async () => {
    const res = await POST(makeReq({ usernames: [] }));
    expect(res.status).toBe(400);
  });

  it("usernames.length > 100 → 400 (anti-DoS cap)", async () => {
    const big = Array.from({ length: 101 }, (_, i) => `u${i}`);
    const res = await POST(makeReq({ usernames: big }));
    expect(res.status).toBe(400);
    expect(daDeleteUser).not.toHaveBeenCalled();
  });

  it("usernames.length === 100 → accepted (boundary)", async () => {
    const onehundred = Array.from({ length: 100 }, (_, i) => `u${i}`);
    daDeleteUser.mockResolvedValue({ kind: "deleted" });
    const res = await POST(makeReq({ usernames: onehundred }));
    expect(res.status).toBe(200);
    expect(daDeleteUser).toHaveBeenCalledTimes(100);
  });

  it("username string too long (>100 chars) → 400", async () => {
    const res = await POST(
      makeReq({ usernames: ["x".repeat(101)] })
    );
    expect(res.status).toBe(400);
  });
});

describe("4-branch typed-outcome dispatch", () => {
  beforeEach(() => {
    isAdmin.mockResolvedValue(true);
  });

  it("'deleted' → success:true, outcome:'deleted', no error field", async () => {
    daDeleteUser.mockResolvedValueOnce({ kind: "deleted" });
    const res = await POST(makeReq({ usernames: ["u1"] }));
    const body = await res.json();
    expect(body.data[0]).toEqual({
      username: "u1",
      success: true,
      outcome: "deleted",
    });
  });

  it("'user_not_found' → success:true (coalesced with deleted — end state matches intent)", async () => {
    daDeleteUser.mockResolvedValueOnce({ kind: "user_not_found" });
    const res = await POST(makeReq({ usernames: ["u_gone"] }));
    const body = await res.json();
    expect(body.data[0]).toEqual({
      username: "u_gone",
      success: true,
      outcome: "user_not_found",
    });
  });

  it("'da_unreachable' → success:false, retryable error message", async () => {
    daDeleteUser.mockResolvedValueOnce({ kind: "da_unreachable" });
    const res = await POST(makeReq({ usernames: ["u1"] }));
    const body = await res.json();
    expect(body.data[0]).toEqual({
      username: "u1",
      success: false,
      outcome: "da_unreachable",
      error: "DA temporarily unreachable — try again",
    });
  });

  it("'hard_failure' → success:false, 'see server logs' message", async () => {
    daDeleteUser.mockResolvedValueOnce({ kind: "hard_failure" });
    const res = await POST(makeReq({ usernames: ["u1"] }));
    const body = await res.json();
    expect(body.data[0]).toEqual({
      username: "u1",
      success: false,
      outcome: "hard_failure",
      error: "Delete failed — see server logs",
    });
  });
});

describe("Per-username failure isolation", () => {
  beforeEach(() => {
    isAdmin.mockResolvedValue(true);
  });

  it("one da_unreachable in the middle does NOT abort the loop — subsequent usernames still processed", async () => {
    daDeleteUser
      .mockResolvedValueOnce({ kind: "deleted" })
      .mockResolvedValueOnce({ kind: "da_unreachable" })
      .mockResolvedValueOnce({ kind: "user_not_found" });

    const res = await POST(
      makeReq({ usernames: ["u1", "u_unreachable", "u_gone"] })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(3);
    expect(body.data[0].success).toBe(true);
    expect(body.data[1].success).toBe(false);
    expect(body.data[2].success).toBe(true);
  });

  it("hard_failure in the middle also doesn't abort", async () => {
    daDeleteUser
      .mockResolvedValueOnce({ kind: "hard_failure" })
      .mockResolvedValueOnce({ kind: "deleted" });

    const res = await POST(makeReq({ usernames: ["u_broken", "u_ok"] }));
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].success).toBe(false);
    expect(body.data[1].success).toBe(true);
  });
});

describe("Outer catch", () => {
  it("connectDB throw → 500 CLEANUP_FAILED with error.message (matches 7gr/7gt family quirk)", async () => {
    isAdmin.mockResolvedValueOnce(true);
    connectDB.mockRejectedValueOnce(new Error("Mongo: shard down"));
    const res = await POST(makeReq({ usernames: ["u1"] }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("CLEANUP_FAILED");
    expect(body.error).toBe("Mongo: shard down");
  });

  it("non-Error throw → 'Cleanup failed' fallback", async () => {
    isAdmin.mockResolvedValueOnce(true);
    connectDB.mockRejectedValueOnce("string-throw");
    const res = await POST(makeReq({ usernames: ["u1"] }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Cleanup failed");
  });
});
