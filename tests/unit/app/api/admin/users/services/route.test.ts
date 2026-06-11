/**
 * Tests for `app/api/admin/users/services/route.ts` (slice 7hh,
 * part 1). Admin overview of all users who own at least one
 * domain or hosting account.
 *
 * Pins:
 *  - **Session-based auth** via NextAuth getServerSession with
 *    role==='admin' check (NOT AuthService.isAdmin — this route
 *    uses the session-cookie path for the admin dashboard).
 *    Non-admin / no session → 401 'Unauthorized access'
 *  - **Aggregation as primary source**: listUsersWithServicesAggregation
 *    returns every user with at least one Domain or Hosting row
 *  - **Fallback merge**: listServiceUserCandidates catches users
 *    who have a directAdminUsername but were missed by the
 *    aggregation (e.g. legacy DA accounts without a Hosting row).
 *    Synthetic 'Pending Sync' hosting entry constructed from User
 *    fields.
 *  - **Set-based dedup** (O(n+m), not O(n·m)) — pinned because
 *    the .some() variant would degrade quadratically as user-base
 *    grows. Test asserts a user present in BOTH lists appears
 *    exactly once.
 *  - **No live DirectAdmin call** — pinned because skipping the
 *    real-time DA verification is deliberate to avoid timeouts
 *    on the list view (the source comment notes this explicitly)
 *  - Response: `{ success, users, count }` with count===users.length
 *  - Outer catch → 500 with error.message surfaced (current
 *    behaviour — pinned alongside the 7gr/7gt family leak quirk)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getServerSession = vi.hoisted(() => vi.fn());
vi.mock("next-auth", () => ({ getServerSession }));
vi.mock("@/lib/auth-config", () => ({ authOptions: {} }));

const listServiceUserCandidates = vi.hoisted(() => vi.fn());
const listUsersWithServicesAggregation = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({
  listServiceUserCandidates,
  listUsersWithServicesAggregation,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/admin/users/services/route";

function makeReq() {
  return new Request("https://example.com/api/admin/users/services");
}

beforeEach(() => {
  getServerSession.mockReset();
  listServiceUserCandidates.mockReset();
  listUsersWithServicesAggregation.mockReset();
});

describe("Session-based auth", () => {
  it("no session → 401 'Unauthorized access'", async () => {
    getServerSession.mockResolvedValueOnce(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized access");
    expect(listUsersWithServicesAggregation).not.toHaveBeenCalled();
  });

  it("session present but user.role !== 'admin' → 401", async () => {
    getServerSession.mockResolvedValueOnce({
      user: { role: "user", id: "U1" },
    });
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    expect(listUsersWithServicesAggregation).not.toHaveBeenCalled();
  });

  it("session present + role=admin → proceeds", async () => {
    getServerSession.mockResolvedValueOnce({
      user: { role: "admin", id: "A1" },
    });
    listUsersWithServicesAggregation.mockResolvedValueOnce([]);
    listServiceUserCandidates.mockResolvedValueOnce([]);

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
  });
});

describe("Aggregation primary source", () => {
  it("returns the aggregation result verbatim when no fallback users", async () => {
    getServerSession.mockResolvedValueOnce({
      user: { role: "admin", id: "A1" },
    });
    listUsersWithServicesAggregation.mockResolvedValueOnce([
      {
        _id: { toString: () => "U1" },
        email: "alice@example.com",
        domains: [{ domainName: "alice.com" }],
        hosting: [],
      },
      {
        _id: { toString: () => "U2" },
        email: "bob@example.com",
        domains: [],
        hosting: [{ domainName: "bob.com", status: "active" }],
      },
    ]);
    listServiceUserCandidates.mockResolvedValueOnce([]);

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.users).toHaveLength(2);
    expect(body.count).toBe(2);
  });
});

describe("Fallback merge — Set-based dedup (O(n+m))", () => {
  it("user already in aggregation is NOT added again from fallback list", async () => {
    getServerSession.mockResolvedValueOnce({
      user: { role: "admin", id: "A1" },
    });
    listUsersWithServicesAggregation.mockResolvedValueOnce([
      {
        _id: { toString: () => "U1" },
        email: "alice@example.com",
        domains: [],
        hosting: [{ domainName: "alice.com", status: "active" }],
      },
    ]);
    listServiceUserCandidates.mockResolvedValueOnce([
      // U1 is already in the aggregation — must NOT be re-added
      {
        _id: "U1",
        email: "alice@example.com",
        directAdminUsername: "alice_da",
      },
    ]);

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.users).toHaveLength(1);
    expect(body.count).toBe(1);
  });

  it("fallback user NOT in aggregation → appended with synthetic 'Pending Sync' hosting entry", async () => {
    getServerSession.mockResolvedValueOnce({
      user: { role: "admin", id: "A1" },
    });
    listUsersWithServicesAggregation.mockResolvedValueOnce([]);
    listServiceUserCandidates.mockResolvedValueOnce([
      {
        _id: "U_LEGACY",
        email: "legacy@example.com",
        firstName: "Legacy",
        lastName: "User",
        role: "user",
        isActive: true,
        createdAt: new Date("2024-01-01"),
        directAdminUsername: "legacy_da",
        hostingExpiresAt: new Date("2027-01-01"),
        hostingCreatedAt: new Date("2024-01-01"),
      },
    ]);

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.users).toHaveLength(1);
    const u = body.users[0];
    expect(u.email).toBe("legacy@example.com");
    expect(u.directAdminUsername).toBe("legacy_da");
    expect(u.domains).toEqual([]); // synthetic — no Lookup
    expect(u.hosting).toHaveLength(1);
    expect(u.hosting[0]).toEqual(
      expect.objectContaining({
        domainName: "Pending Sync",
        status: "active",
        name: "Standard Hosting",
      })
    );
  });
});

describe("No live DirectAdmin call (deliberate — anti-timeout)", () => {
  it("happy path completes without ANY mock of DirectAdminService — if the handler reached DA it would crash", async () => {
    // We deliberately don't mock DirectAdminService at all. If a refactor
    // re-introduces a live DA verification call on the list view, this
    // test crashes the moment it tries to import DirectAdminService.
    getServerSession.mockResolvedValueOnce({
      user: { role: "admin", id: "A1" },
    });
    listUsersWithServicesAggregation.mockResolvedValueOnce([
      {
        _id: { toString: () => "U1" },
        email: "alice@example.com",
        directAdminUsername: "alice_da",
        domains: [],
        hosting: [{ domainName: "alice.com", status: "active" }],
      },
    ]);
    listServiceUserCandidates.mockResolvedValueOnce([]);

    const res = await GET(makeReq());
    expect(res.status).toBe(200);
  });
});

describe("Response shape", () => {
  it("returns { success:true, users, count } with count === users.length", async () => {
    getServerSession.mockResolvedValueOnce({
      user: { role: "admin", id: "A1" },
    });
    listUsersWithServicesAggregation.mockResolvedValueOnce([
      { _id: { toString: () => "U1" }, email: "a@x.com", domains: [], hosting: [] },
      { _id: { toString: () => "U2" }, email: "b@x.com", domains: [], hosting: [] },
      { _id: { toString: () => "U3" }, email: "c@x.com", domains: [], hosting: [] },
    ]);
    listServiceUserCandidates.mockResolvedValueOnce([]);

    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.users).toHaveLength(3);
    expect(body.count).toBe(3);
  });
});

describe("Outer catch", () => {
  it("aggregation throw → 500 with error.message (current behaviour pinned alongside 7gr/7gt family)", async () => {
    getServerSession.mockResolvedValueOnce({
      user: { role: "admin", id: "A1" },
    });
    listUsersWithServicesAggregation.mockRejectedValueOnce(
      new Error("Mongo aggregation timeout")
    );
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Mongo aggregation timeout");
  });

  it("non-Error throw → 'Failed to fetch service users' fallback", async () => {
    getServerSession.mockResolvedValueOnce({
      user: { role: "admin", id: "A1" },
    });
    listUsersWithServicesAggregation.mockRejectedValueOnce("string-throw");
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to fetch service users");
  });
});
