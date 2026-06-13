/**
 * Tests for `app/api/workers/sync-hosting-status/route.ts` (slice 7hz, part 2).
 *
 * Cron-fired worker that syncs each of a single user's hostings
 * against DirectAdmin (suspended/terminated/active flips).
 *
 * Threat model:
 *  - **Open machine endpoint**: cron-secret ONLY; no admin-session
 *    fallback. Pinned.
 *  - **False-positive terminate**: a flaky `getUserDomains` returning
 *    [] would otherwise terminate every hosting on that DA account.
 *    Pinned: `userDomains.length > 0` precondition before the
 *    "domain missing → terminate" branch.
 *  - **Mass-termination on DA outage**: a 5-minute DA blip would
 *    mark every active hosting terminated. Pinned: `da_unreachable`
 *    → skip (NOT terminate).
 *
 * Other pins:
 *  - cron-secret missing → 401; NO listHostingsForUser
 *  - zod userId required → 400
 *  - listHostingsForUser called with { limit: 0 } (no truncation)
 *  - Empty list → "No hostings found"; no DA call
 *  - Skip non-active/suspended statuses (terminated, pending, etc.)
 *  - Skip hostings without directAdminUsername
 *  - DA outcome 4-branch:
 *      user_not_found → status:'terminated' + autoRenew:false + save
 *      da_unreachable → log + skip (NO mutation)
 *      hard_failure   → log + skip (NO mutation)
 *      found          → proceed to suspended/active check
 *  - When found:
 *      suspended==='yes' → flip to 'suspended' (only saves on change)
 *      suspended==='no' + domain present in userDomains → flip to
 *        'active' (only saves on change)
 *      suspended==='no' + domain MISSING + userDomains.length>0 →
 *        terminate + autoRenew:false + save
 *      suspended==='no' + domain MISSING + userDomains is empty →
 *        treat as failed getUserDomains; flip to active anyway (NO
 *        false-positive terminate)
 *  - getUserDomains case-insensitive match
 *  - getUserDomains throw → caught; proceed AS IF empty (NO false-
 *    positive terminate)
 *  - per-hosting Promise.allSettled isolation
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const authorizeCronRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cron-auth", () => ({ authorizeCronRequest }));

const listHostingsForUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hostings", () => ({ listHostingsForUser }));

const getUserDomains = vi.hoisted(() => vi.fn());
vi.mock("@/lib/directadmin", () => ({
  DirectAdminService: { getUserDomains },
}));

const daGetUserConfig = vi.hoisted(() => vi.fn());
vi.mock("@/lib/integrations/directadmin", () => ({
  getUserConfig: daGetUserConfig,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/workers/sync-hosting-status/route";

function makeReq(body: unknown) {
  return new NextRequest(
    "https://example.com/api/workers/sync-hosting-status",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

type FakeHosting = {
  status: string;
  domainName: string;
  directAdminUsername?: string;
  autoRenew?: boolean;
  save: ReturnType<typeof vi.fn>;
};

function makeHosting(overrides: Partial<FakeHosting> = {}): FakeHosting {
  return {
    status: "active",
    domainName: "x.com",
    directAdminUsername: "user_da",
    autoRenew: true,
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  authorizeCronRequest.mockReset();
  listHostingsForUser.mockReset();
  getUserDomains.mockReset();
  daGetUserConfig.mockReset();
});

describe("Cron-secret only auth", () => {
  it("no secret → 401 UNAUTHORIZED; NO listHostingsForUser", async () => {
    authorizeCronRequest.mockReturnValueOnce(false);
    const res = await POST(makeReq({ userId: "U1" }));
    expect(res.status).toBe(401);
    expect(listHostingsForUser).not.toHaveBeenCalled();
  });
});

describe("Zod schema", () => {
  beforeEach(() => {
    authorizeCronRequest.mockReturnValue(true);
  });

  it("missing userId → 400", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    expect(listHostingsForUser).not.toHaveBeenCalled();
  });

  it("listHostingsForUser called with limit:0 (no truncation)", async () => {
    listHostingsForUser.mockResolvedValueOnce([]);
    await POST(makeReq({ userId: "U1" }));
    expect(listHostingsForUser).toHaveBeenCalledWith(
      "U1",
      expect.objectContaining({ limit: 0 })
    );
  });
});

describe("Empty / skip cases", () => {
  beforeEach(() => {
    authorizeCronRequest.mockReturnValue(true);
  });

  it("no hostings → 200 'No hostings found'", async () => {
    listHostingsForUser.mockResolvedValueOnce([]);
    const res = await POST(makeReq({ userId: "U1" }));
    const body = await res.json();
    expect(body).toEqual({ success: true, message: "No hostings found" });
    expect(daGetUserConfig).not.toHaveBeenCalled();
  });

  it("terminated hosting → SKIPPED; DA NEVER called", async () => {
    const h = makeHosting({ status: "terminated" });
    listHostingsForUser.mockResolvedValueOnce([h]);
    await POST(makeReq({ userId: "U1" }));
    expect(daGetUserConfig).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });

  it("pending hosting → SKIPPED", async () => {
    const h = makeHosting({ status: "pending" });
    listHostingsForUser.mockResolvedValueOnce([h]);
    await POST(makeReq({ userId: "U1" }));
    expect(daGetUserConfig).not.toHaveBeenCalled();
  });

  it("hosting without directAdminUsername → SKIPPED", async () => {
    const h = makeHosting({ directAdminUsername: undefined });
    listHostingsForUser.mockResolvedValueOnce([h]);
    await POST(makeReq({ userId: "U1" }));
    expect(daGetUserConfig).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });
});

describe("DA outcome 4-branch dispatch", () => {
  beforeEach(() => {
    authorizeCronRequest.mockReturnValue(true);
  });

  it("user_not_found → status:'terminated' + autoRenew:false + save", async () => {
    const h = makeHosting();
    listHostingsForUser.mockResolvedValueOnce([h]);
    daGetUserConfig.mockResolvedValueOnce({ kind: "user_not_found" });
    await POST(makeReq({ userId: "U1" }));
    expect(h.status).toBe("terminated");
    expect(h.autoRenew).toBe(false);
    expect(h.save).toHaveBeenCalledTimes(1);
  });

  it("**da_unreachable → SKIP (NO mutation, NO false-positive terminate)** — critical anti-mass-termination", async () => {
    const h = makeHosting();
    listHostingsForUser.mockResolvedValueOnce([h]);
    daGetUserConfig.mockResolvedValueOnce({
      kind: "da_unreachable",
      reason: "ECONNREFUSED",
    });
    await POST(makeReq({ userId: "U1" }));
    expect(h.status).toBe("active"); // unchanged
    expect(h.save).not.toHaveBeenCalled();
    expect(getUserDomains).not.toHaveBeenCalled();
  });

  it("hard_failure → log + skip (NO mutation)", async () => {
    const h = makeHosting();
    listHostingsForUser.mockResolvedValueOnce([h]);
    daGetUserConfig.mockResolvedValueOnce({
      kind: "hard_failure",
      reason: "weird DA error",
    });
    await POST(makeReq({ userId: "U1" }));
    expect(h.save).not.toHaveBeenCalled();
  });
});

describe("Found branch — suspension flip", () => {
  beforeEach(() => {
    authorizeCronRequest.mockReturnValue(true);
  });

  it("DA suspended='yes' + status='active' → flip to 'suspended' + save", async () => {
    const h = makeHosting({ status: "active" });
    listHostingsForUser.mockResolvedValueOnce([h]);
    daGetUserConfig.mockResolvedValueOnce({
      kind: "found",
      config: { suspended: "yes" },
    });
    getUserDomains.mockResolvedValueOnce([]);
    await POST(makeReq({ userId: "U1" }));
    expect(h.status).toBe("suspended");
    expect(h.save).toHaveBeenCalledTimes(1);
  });

  it("DA suspended='yes' + status already 'suspended' → NO save (idempotent)", async () => {
    const h = makeHosting({ status: "suspended" });
    listHostingsForUser.mockResolvedValueOnce([h]);
    daGetUserConfig.mockResolvedValueOnce({
      kind: "found",
      config: { suspended: "yes" },
    });
    await POST(makeReq({ userId: "U1" }));
    expect(h.save).not.toHaveBeenCalled();
  });
});

describe("Found branch — active + domain-presence", () => {
  beforeEach(() => {
    authorizeCronRequest.mockReturnValue(true);
  });

  it("suspended='no' + domain present + status was 'suspended' → flip to 'active' + save", async () => {
    const h = makeHosting({ status: "suspended" });
    listHostingsForUser.mockResolvedValueOnce([h]);
    daGetUserConfig.mockResolvedValueOnce({
      kind: "found",
      config: { suspended: "no" },
    });
    getUserDomains.mockResolvedValueOnce(["x.com"]);
    await POST(makeReq({ userId: "U1" }));
    expect(h.status).toBe("active");
    expect(h.save).toHaveBeenCalledTimes(1);
  });

  it("suspended='no' + domain present + status already 'active' → NO save (idempotent)", async () => {
    const h = makeHosting({ status: "active" });
    listHostingsForUser.mockResolvedValueOnce([h]);
    daGetUserConfig.mockResolvedValueOnce({
      kind: "found",
      config: { suspended: "no" },
    });
    getUserDomains.mockResolvedValueOnce(["x.com"]);
    await POST(makeReq({ userId: "U1" }));
    expect(h.save).not.toHaveBeenCalled();
  });

  it("getUserDomains case-insensitive match: stored 'X.COM', DA returns 'x.com' → match (active)", async () => {
    const h = makeHosting({ status: "suspended", domainName: "X.COM" });
    listHostingsForUser.mockResolvedValueOnce([h]);
    daGetUserConfig.mockResolvedValueOnce({
      kind: "found",
      config: { suspended: "no" },
    });
    getUserDomains.mockResolvedValueOnce(["x.com"]);
    await POST(makeReq({ userId: "U1" }));
    expect(h.status).toBe("active");
  });

  it("**domain MISSING + userDomains non-empty → TERMINATE + autoRenew:false + save**", async () => {
    const h = makeHosting({ status: "active", domainName: "missing.com" });
    listHostingsForUser.mockResolvedValueOnce([h]);
    daGetUserConfig.mockResolvedValueOnce({
      kind: "found",
      config: { suspended: "no" },
    });
    getUserDomains.mockResolvedValueOnce(["other.com"]);
    await POST(makeReq({ userId: "U1" }));
    expect(h.status).toBe("terminated");
    expect(h.autoRenew).toBe(false);
    expect(h.save).toHaveBeenCalledTimes(1);
  });

  it("**ANTI-FALSE-POSITIVE: domain MISSING + userDomains is EMPTY → status flipped to 'active' (NOT terminated)**", async () => {
    const h = makeHosting({ status: "suspended", domainName: "x.com" });
    listHostingsForUser.mockResolvedValueOnce([h]);
    daGetUserConfig.mockResolvedValueOnce({
      kind: "found",
      config: { suspended: "no" },
    });
    getUserDomains.mockResolvedValueOnce([]); // empty — would trigger false-positive without guard
    await POST(makeReq({ userId: "U1" }));
    expect(h.status).toBe("active"); // NOT terminated
    expect(h.save).toHaveBeenCalledTimes(1);
  });

  it("**ANTI-FALSE-POSITIVE: getUserDomains THROW → caught; proceed with empty list; flip to active (NOT terminated)**", async () => {
    const h = makeHosting({ status: "suspended", domainName: "x.com" });
    listHostingsForUser.mockResolvedValueOnce([h]);
    daGetUserConfig.mockResolvedValueOnce({
      kind: "found",
      config: { suspended: "no" },
    });
    getUserDomains.mockRejectedValueOnce(new Error("DA domains probe failed"));
    await POST(makeReq({ userId: "U1" }));
    expect(h.status).toBe("active"); // NOT terminated; soft-fail
    expect(h.save).toHaveBeenCalledTimes(1);
  });
});

describe("Per-hosting isolation", () => {
  beforeEach(() => {
    authorizeCronRequest.mockReturnValue(true);
  });

  it("one hosting's save() throw → other hostings still processed (Promise.allSettled)", async () => {
    const h1 = makeHosting({ domainName: "fail.com" });
    h1.save = vi.fn().mockRejectedValueOnce(new Error("Mongo blip on h1"));
    const h2 = makeHosting({ domainName: "ok.com" });
    listHostingsForUser.mockResolvedValueOnce([h1, h2]);
    daGetUserConfig.mockResolvedValue({ kind: "user_not_found" });
    const res = await POST(makeReq({ userId: "U1" }));
    expect(res.status).toBe(200);
    expect(h2.save).toHaveBeenCalledTimes(1);
    expect(h2.status).toBe("terminated");
  });
});

describe("Outer catch", () => {
  it("listHostingsForUser throw → 500", async () => {
    authorizeCronRequest.mockReturnValueOnce(true);
    listHostingsForUser.mockRejectedValueOnce(new Error("Mongo down"));
    const res = await POST(makeReq({ userId: "U1" }));
    expect(res.status).toBe(500);
  });
});
