/**
 * Tests for `app/api/admin/diag-da/route.ts` (slice 7hi, part 1).
 * Admin diagnostics page that pulls DirectAdmin license / user /
 * reseller / system info in parallel for cross-reference with the
 * local Hosting collection.
 *
 * Pins:
 *  - Admin gate via isAdmin → 403 FORBIDDEN (NOT 401)
 *  - **Promise.allSettled fan-out for the 4 DA reads** — one
 *    source failing doesn't kill the page; failed sources are
 *    wrapped as `{ error: <message> }` so the dashboard can show
 *    a per-card status
 *  - listAllHostingsForDirectAdminDiag always called (DB lookup
 *    is fast, no need to gate on a flag)
 *  - **Optional inline cleanup via ?cleanup=true**: only runs
 *    when query flag set, then results returned under
 *    `cleanupResults`. When NOT set, the field is `undefined` on
 *    the response.
 *  - Cleanup orphan list is HARDCODED: ttgr6jne / ttgrgm6jme /
 *    ttgrgm6jme1 (pinned — these were the originally-stuck DA
 *    accounts the cleanup tool was built for; a refactor that
 *    changes the list should require explicit review)
 *  - Cleanup outcome dispatch: 'deleted' / 'user_not_found' →
 *    no error; 'da_unreachable' → 'DA unreachable'; else →
 *    'delete failed — see server logs'
 *  - Outer catch → 500 DIAG_FAILED with raw error.message
 *    (matches 7gr/7gt family leak quirk)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const isAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { isAdmin },
}));

const listUsers = vi.hoisted(() => vi.fn());
const listResellers = vi.hoisted(() => vi.fn());
const getLicenseInfo = vi.hoisted(() => vi.fn());
const getServerInfo = vi.hoisted(() => vi.fn());
vi.mock("@/lib/directadmin", () => ({
  DirectAdminService: {
    listUsers,
    listResellers,
    getLicenseInfo,
    getServerInfo,
  },
}));

const daDeleteUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/integrations/directadmin", () => ({
  deleteUser: daDeleteUser,
}));

const listAllHostingsForDirectAdminDiag = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hostings", () => ({
  listAllHostingsForDirectAdminDiag,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/admin/diag-da/route";

function makeReq(qs = "") {
  const url = qs
    ? `https://example.com/api/admin/diag-da?${qs}`
    : "https://example.com/api/admin/diag-da";
  return new NextRequest(url, { method: "GET" });
}

beforeEach(() => {
  isAdmin.mockReset();
  listUsers.mockReset();
  listResellers.mockReset();
  getLicenseInfo.mockReset();
  getServerInfo.mockReset();
  daDeleteUser.mockReset();
  listAllHostingsForDirectAdminDiag.mockReset().mockResolvedValue([]);
});

describe("Admin gate (403, not 401)", () => {
  it("non-admin → 403 FORBIDDEN; NO DA calls, NO DB hit", async () => {
    isAdmin.mockResolvedValueOnce(false);
    const res = await GET(makeReq());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(listUsers).not.toHaveBeenCalled();
    expect(listAllHostingsForDirectAdminDiag).not.toHaveBeenCalled();
  });
});

describe("Promise.allSettled fan-out — partial failure tolerance", () => {
  beforeEach(() => {
    isAdmin.mockResolvedValue(true);
  });

  it("all 4 DA calls succeed → all 4 values reach the response", async () => {
    listUsers.mockResolvedValueOnce(["u1", "u2"]);
    listResellers.mockResolvedValueOnce(["r1"]);
    getLicenseInfo.mockResolvedValueOnce({ licenseId: "L1" });
    getServerInfo.mockResolvedValueOnce({ php: "8.2" });

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.users).toEqual(["u1", "u2"]);
    expect(body.data.resellers).toEqual(["r1"]);
    expect(body.data.license).toEqual({ licenseId: "L1" });
    expect(body.data.system).toEqual({ php: "8.2" });
  });

  it("ONE source failing does NOT abort the page — that source returns `{error: <message>}`, others still populated", async () => {
    listUsers.mockResolvedValueOnce(["u1"]);
    listResellers.mockRejectedValueOnce(new Error("DA resellers timeout"));
    getLicenseInfo.mockResolvedValueOnce({ licenseId: "L1" });
    getServerInfo.mockResolvedValueOnce({ php: "8.2" });

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.users).toEqual(["u1"]);
    expect(body.data.resellers).toEqual({ error: "DA resellers timeout" });
    expect(body.data.license).toEqual({ licenseId: "L1" });
    expect(body.data.system).toEqual({ php: "8.2" });
  });

  it("non-Error rejection → coerced via String() — pinned to confirm no crash on weird throws", async () => {
    listUsers.mockResolvedValueOnce([]);
    listResellers.mockResolvedValueOnce([]);
    getLicenseInfo.mockRejectedValueOnce("string-throw");
    getServerInfo.mockResolvedValueOnce({});

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.data.license).toEqual({ error: "string-throw" });
  });

  it("ALL 4 DA sources failing → all 4 errors surface but page still 200", async () => {
    listUsers.mockRejectedValueOnce(new Error("DA down"));
    listResellers.mockRejectedValueOnce(new Error("DA down"));
    getLicenseInfo.mockRejectedValueOnce(new Error("DA down"));
    getServerInfo.mockRejectedValueOnce(new Error("DA down"));

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.users).toEqual({ error: "DA down" });
    expect(body.data.resellers).toEqual({ error: "DA down" });
    expect(body.data.license).toEqual({ error: "DA down" });
    expect(body.data.system).toEqual({ error: "DA down" });
  });
});

describe("DB hosting lookup", () => {
  it("listAllHostingsForDirectAdminDiag always called (no flag)", async () => {
    isAdmin.mockResolvedValueOnce(true);
    listUsers.mockResolvedValueOnce([]);
    listResellers.mockResolvedValueOnce([]);
    getLicenseInfo.mockResolvedValueOnce({});
    getServerInfo.mockResolvedValueOnce({});

    await GET(makeReq());
    expect(listAllHostingsForDirectAdminDiag).toHaveBeenCalled();
  });

  it("DB hostings surface under data.database", async () => {
    isAdmin.mockResolvedValueOnce(true);
    listUsers.mockResolvedValueOnce([]);
    listResellers.mockResolvedValueOnce([]);
    getLicenseInfo.mockResolvedValueOnce({});
    getServerInfo.mockResolvedValueOnce({});
    listAllHostingsForDirectAdminDiag.mockResolvedValueOnce([
      { _id: "H1", domainName: "alice.com" },
    ]);

    const body = await (await GET(makeReq())).json();
    expect(body.data.database).toEqual([
      { _id: "H1", domainName: "alice.com" },
    ]);
  });
});

describe("Optional inline cleanup", () => {
  beforeEach(() => {
    isAdmin.mockResolvedValue(true);
    listUsers.mockResolvedValueOnce([]);
    listResellers.mockResolvedValueOnce([]);
    getLicenseInfo.mockResolvedValueOnce({});
    getServerInfo.mockResolvedValueOnce({});
  });

  it("?cleanup not set → cleanupResults absent from response", async () => {
    const body = await (await GET(makeReq())).json();
    expect(body.data.cleanupResults).toBeUndefined();
    expect(daDeleteUser).not.toHaveBeenCalled();
  });

  it("?cleanup=true → hardcoded orphan list iterated; each delete result captured", async () => {
    daDeleteUser
      .mockResolvedValueOnce({ kind: "deleted" })
      .mockResolvedValueOnce({ kind: "user_not_found" })
      .mockResolvedValueOnce({ kind: "deleted" });

    const body = await (await GET(makeReq("cleanup=true"))).json();
    expect(body.data.cleanupResults).toHaveLength(3);

    // Hardcoded orphan list pinned: ttgr6jne, ttgrgm6jme, ttgrgm6jme1
    expect(daDeleteUser).toHaveBeenNthCalledWith(1, { username: "ttgr6jne" });
    expect(daDeleteUser).toHaveBeenNthCalledWith(2, {
      username: "ttgrgm6jme",
    });
    expect(daDeleteUser).toHaveBeenNthCalledWith(3, {
      username: "ttgrgm6jme1",
    });
  });

  it("?cleanup=true with da_unreachable → result includes 'DA unreachable' error", async () => {
    daDeleteUser
      .mockResolvedValueOnce({ kind: "deleted" })
      .mockResolvedValueOnce({ kind: "da_unreachable" })
      .mockResolvedValueOnce({ kind: "hard_failure" });

    const body = await (await GET(makeReq("cleanup=true"))).json();
    expect(body.data.cleanupResults[1]).toEqual({
      username: "ttgrgm6jme",
      status: "da_unreachable",
      error: "DA unreachable",
    });
    expect(body.data.cleanupResults[2]).toEqual({
      username: "ttgrgm6jme1",
      status: "hard_failure",
      error: "delete failed — see server logs",
    });
  });

  it("?cleanup=anything-other-than-true → cleanup NOT triggered (strict equality)", async () => {
    const body = await (await GET(makeReq("cleanup=yes"))).json();
    expect(body.data.cleanupResults).toBeUndefined();
    expect(daDeleteUser).not.toHaveBeenCalled();
  });
});

describe("Outer catch", () => {
  it("listAllHostingsForDirectAdminDiag throw → 500 DIAG_FAILED with error.message (matches family leak pattern)", async () => {
    isAdmin.mockResolvedValueOnce(true);
    listUsers.mockResolvedValueOnce([]);
    listResellers.mockResolvedValueOnce([]);
    getLicenseInfo.mockResolvedValueOnce({});
    getServerInfo.mockResolvedValueOnce({});
    listAllHostingsForDirectAdminDiag.mockRejectedValueOnce(
      new Error("Mongo: shard-2 timeout")
    );

    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("DIAG_FAILED");
    expect(body.error).toBe("Mongo: shard-2 timeout");
  });
});
