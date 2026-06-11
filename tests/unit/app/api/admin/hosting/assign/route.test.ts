/**
 * Tests for `app/api/admin/hosting/assign/route.ts` (slice 7hl, part 1).
 *
 * Manual admin path to assign a hosting package to an existing customer.
 * Used when the admin needs to bypass the checkout flow (e.g. comped
 * accounts, migrated customers, support recovery).
 *
 * Threat model:
 *  - **Non-admin uplift**: a session-authed user must NOT be able to
 *    create DA accounts for arbitrary users. Pinned via the admin gate
 *    BEFORE body parse + zod.
 *  - **Username collision via predictable-suffix**: the auto-generated
 *    DA username is `cleanDomain[:8] + base36-random[:4]`, lower-cased
 *    and truncated to 14 chars. Pinned so a refactor doesn't widen the
 *    keyspace silently (or break the 14-char DA cap).
 *  - **DNS-step soft-failure**: the post-create DNS nameserver update
 *    is best-effort — a refactor that lets it throw would cascade and
 *    return 500 even though the DA account already exists. Pinned.
 *
 * Other pins:
 *  - 404 USER_NOT_FOUND for unknown userId
 *  - createUser called with (daUsername, email, domain, packageName)
 *  - DNS nameservers are the 4 hard-coded ResellerClub
 *    `deepak1299294.{mercury,venus,earth,mars}.orderbox-dns.com`
 *  - user.directAdminUsername is set ONLY when previously empty
 *    (don't clobber an existing link)
 *  - Outer catch: error.message.includes("already exists") → 409
 *    ALREADY_EXISTS; else → 500 ASSIGNMENT_FAILED with raw message in
 *    the error string (known family quirk — pinned, not gated, future
 *    hardening tracked alongside 7gr/7gt/7gu/7he/7hi).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const isAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { isAdmin },
}));

const createUser = vi.hoisted(() => vi.fn());
const updateDNSNameservers = vi.hoisted(() => vi.fn());
vi.mock("@/lib/directadmin", () => ({
  DirectAdminService: { createUser, updateDNSNameservers },
}));

const getUserById = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ getUserById }));

vi.mock("@/lib/mongodb", () => ({ default: vi.fn().mockResolvedValue(undefined) }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/admin/hosting/assign/route";

type FakeUser = {
  _id: string;
  email: string;
  directAdminUsername?: string;
  save: ReturnType<typeof vi.fn>;
};

function makeReq(body: unknown) {
  return new NextRequest("https://example.com/api/admin/hosting/assign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  isAdmin.mockReset().mockResolvedValue(true);
  getUserById.mockReset();
  createUser.mockReset();
  updateDNSNameservers.mockReset();
});

describe("Admin gate (BEFORE body parse / zod)", () => {
  it("non-admin → 403 FORBIDDEN; createUser NOT called", async () => {
    isAdmin.mockResolvedValueOnce(false);
    const res = await POST(
      makeReq({
        userId: "507f1f77bcf86cd799439011",
        package: "basic",
        domain: "example.com",
      })
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(getUserById).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
  });

  it("non-admin with NO body → still 403, not a 400 (admin gate is first)", async () => {
    isAdmin.mockResolvedValueOnce(false);
    // Empty body — if the gate ran AFTER body parse, zod would fail
    // with a 400 instead.
    const res = await POST(
      new NextRequest("https://example.com/api/admin/hosting/assign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    );
    expect(res.status).toBe(403);
  });
});

describe("Zod schema", () => {
  it("missing userId → 400 (validation error)", async () => {
    const res = await POST(makeReq({ package: "basic", domain: "x.com" }));
    expect(res.status).toBe(400);
    expect(getUserById).not.toHaveBeenCalled();
  });

  it("domain < 3 chars → 400", async () => {
    const res = await POST(
      makeReq({
        userId: "507f1f77bcf86cd799439011",
        package: "basic",
        domain: "a",
      })
    );
    expect(res.status).toBe(400);
  });

  it("package empty string → 400 (z.string().min(1))", async () => {
    const res = await POST(
      makeReq({
        userId: "507f1f77bcf86cd799439011",
        package: "",
        domain: "example.com",
      })
    );
    expect(res.status).toBe(400);
  });

  it("domain is lower-cased + trimmed by zod before reaching DA", async () => {
    const user: FakeUser = {
      _id: "U1",
      email: "alice@example.com",
      directAdminUsername: "alice_da",
      save: vi.fn().mockResolvedValue(undefined),
    };
    getUserById.mockResolvedValueOnce(user);
    createUser.mockResolvedValueOnce({ ok: true });
    updateDNSNameservers.mockResolvedValueOnce(undefined);

    await POST(
      makeReq({
        userId: "507f1f77bcf86cd799439011",
        package: "basic",
        domain: "  ExAmPlE.COM  ",
      })
    );

    expect(createUser).toHaveBeenCalledWith(
      "alice_da",
      "alice@example.com",
      "example.com",
      "basic"
    );
  });
});

describe("User lookup", () => {
  it("getUserById null → 404 USER_NOT_FOUND; DA never called", async () => {
    getUserById.mockResolvedValueOnce(null);
    const res = await POST(
      makeReq({
        userId: "507f1f77bcf86cd799439011",
        package: "basic",
        domain: "example.com",
      })
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("USER_NOT_FOUND");
    expect(createUser).not.toHaveBeenCalled();
  });
});

describe("DA username generation (when user.directAdminUsername absent)", () => {
  it("8-char clean-domain prefix + 4-char base36 random; lower-cased; ≤14 chars", async () => {
    const user: FakeUser = {
      _id: "U2",
      email: "bob@example.com",
      // No directAdminUsername — triggers generation.
      save: vi.fn().mockResolvedValue(undefined),
    };
    getUserById.mockResolvedValueOnce(user);
    createUser.mockResolvedValueOnce({ ok: true });
    updateDNSNameservers.mockResolvedValueOnce(undefined);

    // Domain with non-alphanumerics that must be stripped.
    await POST(
      makeReq({
        userId: "507f1f77bcf86cd799439011",
        package: "starter",
        // 'my-cool-site.example.com' → strip non-alphanumeric →
        // 'mycoolsiteexamplecom' → substring(0,8) → 'mycoolsi'
        domain: "my-cool-site.example.com",
      })
    );

    const generated = createUser.mock.calls[0][0] as string;
    expect(generated.length).toBeLessThanOrEqual(14);
    expect(generated).toBe(generated.toLowerCase());
    // Prefix is the 8-char stripped+truncated domain
    expect(generated.startsWith("mycoolsi")).toBe(true);
    // Suffix is the 4-char base36 random
    expect(generated.length).toBeGreaterThanOrEqual(8);
  });

  it("PRESERVES existing user.directAdminUsername; no random suffix added", async () => {
    const user: FakeUser = {
      _id: "U3",
      email: "carol@example.com",
      directAdminUsername: "carol_existing_da_user", // > 14 chars on purpose
      save: vi.fn().mockResolvedValue(undefined),
    };
    getUserById.mockResolvedValueOnce(user);
    createUser.mockResolvedValueOnce({ ok: true });
    updateDNSNameservers.mockResolvedValueOnce(undefined);

    await POST(
      makeReq({
        userId: "507f1f77bcf86cd799439011",
        package: "basic",
        domain: "carol.com",
      })
    );

    expect(createUser).toHaveBeenCalledWith(
      "carol_existing_da_user",
      "carol@example.com",
      "carol.com",
      "basic"
    );
    // user.save NOT called when DA username was already linked
    expect(user.save).not.toHaveBeenCalled();
  });

  it("very short domain after stripping → still ≥3 of base36 suffix appended", async () => {
    const user: FakeUser = {
      _id: "U4",
      email: "d@example.com",
      save: vi.fn().mockResolvedValue(undefined),
    };
    getUserById.mockResolvedValueOnce(user);
    createUser.mockResolvedValueOnce({ ok: true });
    updateDNSNameservers.mockResolvedValueOnce(undefined);

    await POST(
      makeReq({
        userId: "507f1f77bcf86cd799439011",
        package: "basic",
        // Stripped is just "a" (zod min 3 doesn't strip dots).
        domain: "a.x.y",
      })
    );

    const generated = createUser.mock.calls[0][0] as string;
    // axy + 4-char random ≤ 14, lowercase
    expect(generated.length).toBeLessThanOrEqual(14);
    expect(generated.startsWith("axy")).toBe(true);
  });
});

describe("DA createUser call shape", () => {
  it("called with (daUsername, email, domain, packageName) in that order", async () => {
    const user: FakeUser = {
      _id: "U5",
      email: "eve@example.com",
      directAdminUsername: "eve_da",
      save: vi.fn().mockResolvedValue(undefined),
    };
    getUserById.mockResolvedValueOnce(user);
    createUser.mockResolvedValueOnce({ ok: true });
    updateDNSNameservers.mockResolvedValueOnce(undefined);

    await POST(
      makeReq({
        userId: "507f1f77bcf86cd799439011",
        package: "premium",
        domain: "eve.org",
      })
    );

    expect(createUser).toHaveBeenCalledTimes(1);
    expect(createUser).toHaveBeenCalledWith(
      "eve_da",
      "eve@example.com",
      "eve.org",
      "premium"
    );
  });
});

describe("DNS nameserver update — best-effort, post-create", () => {
  it("passes hard-coded 4 ResellerClub `orderbox-dns.com` nameservers", async () => {
    const user: FakeUser = {
      _id: "U6",
      email: "frank@example.com",
      directAdminUsername: "frank_da",
      save: vi.fn().mockResolvedValue(undefined),
    };
    getUserById.mockResolvedValueOnce(user);
    createUser.mockResolvedValueOnce({ ok: true });
    updateDNSNameservers.mockResolvedValueOnce(undefined);

    await POST(
      makeReq({
        userId: "507f1f77bcf86cd799439011",
        package: "basic",
        domain: "frank.com",
      })
    );

    expect(updateDNSNameservers).toHaveBeenCalledWith(
      "frank_da",
      "frank.com",
      [
        "deepak1299294.mercury.orderbox-dns.com",
        "deepak1299294.venus.orderbox-dns.com",
        "deepak1299294.earth.orderbox-dns.com",
        "deepak1299294.mars.orderbox-dns.com",
      ]
    );
  });

  it("DNS step failure is SWALLOWED — assignment still returns 200; user.save still runs", async () => {
    const user: FakeUser = {
      _id: "U7",
      email: "gina@example.com",
      // No DA username — exercises the save-when-empty path AND the
      // DNS-failure swallow simultaneously.
      save: vi.fn().mockResolvedValue(undefined),
    };
    getUserById.mockResolvedValueOnce(user);
    createUser.mockResolvedValueOnce({ ok: true });
    updateDNSNameservers.mockRejectedValueOnce(
      new Error("DA DNS API timed out apk_LEAK_ME_NOT_HERE")
    );

    const res = await POST(
      makeReq({
        userId: "507f1f77bcf86cd799439011",
        package: "basic",
        domain: "gina.com",
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(user.save).toHaveBeenCalledTimes(1);
    // Sentinel leak guard — the swallow-path writes to logger only,
    // never into the JSON response.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("apk_LEAK_ME_NOT_HERE");
  });

  it("DNS step failure does NOT abort the createUser side-effect (it already ran)", async () => {
    const user: FakeUser = {
      _id: "U8",
      email: "henry@example.com",
      directAdminUsername: "henry_da",
      save: vi.fn().mockResolvedValue(undefined),
    };
    getUserById.mockResolvedValueOnce(user);
    createUser.mockResolvedValueOnce({ ok: true });
    updateDNSNameservers.mockRejectedValueOnce(new Error("nope"));

    await POST(
      makeReq({
        userId: "507f1f77bcf86cd799439011",
        package: "basic",
        domain: "henry.com",
      })
    );
    expect(createUser).toHaveBeenCalledTimes(1); // happened, not rolled back
  });
});

describe("Persist linked DA username (CAS-style)", () => {
  it("user.directAdminUsername set ONLY when previously empty", async () => {
    const userFresh: FakeUser = {
      _id: "U9",
      email: "ivy@example.com",
      save: vi.fn().mockResolvedValue(undefined),
    };
    getUserById.mockResolvedValueOnce(userFresh);
    createUser.mockResolvedValueOnce({ ok: true });
    updateDNSNameservers.mockResolvedValueOnce(undefined);

    await POST(
      makeReq({
        userId: "507f1f77bcf86cd799439011",
        package: "basic",
        domain: "ivy.com",
      })
    );
    expect(userFresh.directAdminUsername).toBeDefined();
    expect(userFresh.save).toHaveBeenCalledTimes(1);
  });

  it("user.directAdminUsername NOT overwritten when previously linked", async () => {
    const userLinked: FakeUser = {
      _id: "U10",
      email: "jack@example.com",
      directAdminUsername: "jack_old_da",
      save: vi.fn().mockResolvedValue(undefined),
    };
    getUserById.mockResolvedValueOnce(userLinked);
    createUser.mockResolvedValueOnce({ ok: true });
    updateDNSNameservers.mockResolvedValueOnce(undefined);

    await POST(
      makeReq({
        userId: "507f1f77bcf86cd799439011",
        package: "basic",
        domain: "jack.com",
      })
    );
    expect(userLinked.directAdminUsername).toBe("jack_old_da");
    expect(userLinked.save).not.toHaveBeenCalled();
  });
});

describe("Error mapping — outer catch", () => {
  it("error.message.includes('already exists') → 409 ALREADY_EXISTS", async () => {
    getUserById.mockResolvedValueOnce({
      _id: "U11",
      email: "kim@example.com",
      directAdminUsername: "kim_da",
      save: vi.fn(),
    });
    createUser.mockRejectedValueOnce(new Error("User 'kim_da' already exists"));

    const res = await POST(
      makeReq({
        userId: "507f1f77bcf86cd799439011",
        package: "basic",
        domain: "kim.com",
      })
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("ALREADY_EXISTS");
  });

  it("any other DA error → 500 ASSIGNMENT_FAILED", async () => {
    getUserById.mockResolvedValueOnce({
      _id: "U12",
      email: "lee@example.com",
      directAdminUsername: "lee_da",
      save: vi.fn(),
    });
    createUser.mockRejectedValueOnce(new Error("DA unreachable"));

    const res = await POST(
      makeReq({
        userId: "507f1f77bcf86cd799439011",
        package: "basic",
        domain: "lee.com",
      })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("ASSIGNMENT_FAILED");
  });

  it("FAMILY-QUIRK: 500 ASSIGNMENT_FAILED body STILL leaks raw DA message into the error string (pin — coordinated future hardening with 7gr/7gt/7gu/7he/7hi)", async () => {
    getUserById.mockResolvedValueOnce({
      _id: "U13",
      email: "mia@example.com",
      directAdminUsername: "mia_da",
      save: vi.fn(),
    });
    createUser.mockRejectedValueOnce(
      new Error("ECONNREFUSED 192.0.2.1:2222 — internal DA host")
    );

    const res = await POST(
      makeReq({
        userId: "507f1f77bcf86cd799439011",
        package: "basic",
        domain: "mia.com",
      })
    );
    const body = await res.json();
    expect(body.code).toBe("ASSIGNMENT_FAILED");
    // Known leak — the raw upstream message is concatenated into the
    // human-readable error. We pin the *current* behaviour so a future
    // hardening pass (across the family of routes that share this
    // pattern) is the thing that flips this assertion deliberately.
    expect(body.error).toContain("ECONNREFUSED 192.0.2.1:2222");
  });
});
