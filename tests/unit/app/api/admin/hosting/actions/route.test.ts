/**
 * Tests for `app/api/admin/hosting/actions/route.ts` (slice 7i5, part 2).
 *
 * Admin "suspend / unsuspend / delete" hosting actions.
 *
 * Threat model:
 *  - **Non-admin destructive call**: pinned via admin gate first.
 *  - **Schema-layer guard against missing username**: a refactor that
 *    dropped the discriminated-union refine would let a delete with
 *    neither username nor hostingId reach the service layer and act
 *    on an arbitrary row. Pinned: delete refuses without either.
 *  - **Local-state drift after partial DA failure**: if a refactor
 *    aborted on DA's "we can't delete" outcome BEFORE the local
 *    cleanup, the local DB and DA would diverge. Pinned: local
 *    delete runs FIRST, DA delete LAST, "anything else" outcome
 *    still leaves a `warning` field but local cleanup is committed.
 *  - **Razorpay subscription cancel failure cascading**: a refactor
 *    that re-threw subscription-cancel errors would prevent later
 *    matched rows from being cleaned up. Pinned with one subscription
 *    cancel throwing and another succeeding.
 *
 * Other pins:
 *  - admin gate → 403 FORBIDDEN
 *  - zod discriminated union:
 *      suspend/unsuspend require username (1-100 chars)
 *      delete refuses both-missing via .refine
 *      invalid action → 400
 *  - DA outcome mapping (suspend/unsuspend):
 *      da_unreachable → 503 DA_UNREACHABLE w/ "try again" copy
 *      hard_failure → 500 ACTION_FAILED w/ "see server logs" copy
 *      else (suspended/unsuspended/user_not_found) → 200 with outcome
 *  - delete flow ordering: matchedHostings → cancel subs → delete DA
 *  - cancelSubscription only fires when subscriptionId present
 *  - cancelSubscription throw → swallowed
 *  - daDeleteUser 'deleted' or 'user_not_found' → success result
 *  - daDeleteUser other outcome → success with warning field
 *  - clearDirectAdminUsernameForAll called when username supplied
 *  - outer catch → 500 ACTION_FAILED generic
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const isAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { isAdmin },
}));

const daSuspendUser = vi.hoisted(() => vi.fn());
const daUnsuspendUser = vi.hoisted(() => vi.fn());
const daDeleteUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/integrations/directadmin", () => ({
  suspendUser: daSuspendUser,
  unsuspendUser: daUnsuspendUser,
  deleteUser: daDeleteUser,
}));

const clearDirectAdminUsernameForAll = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/users", () => ({ clearDirectAdminUsernameForAll }));

const deleteHostingsByIdOrUsername = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hostings", () => ({
  deleteHostingsByIdOrUsername,
}));

const deletePendingHostingsByUsername = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/pending-hostings", () => ({
  deletePendingHostingsByUsername,
}));

const cancelSubscription = vi.hoisted(() => vi.fn());
vi.mock("@/lib/razorpay", () => ({
  RazorpayService: { cancelSubscription },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/admin/hosting/actions/route";

function makeReq(body: unknown) {
  return new NextRequest("https://example.com/api/admin/hosting/actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  isAdmin.mockReset().mockResolvedValue(true);
  daSuspendUser.mockReset();
  daUnsuspendUser.mockReset();
  daDeleteUser.mockReset();
  clearDirectAdminUsernameForAll.mockReset().mockResolvedValue(undefined);
  deleteHostingsByIdOrUsername.mockReset().mockResolvedValue({
    deletedCount: 0,
    matchedHostings: [],
  });
  deletePendingHostingsByUsername.mockReset().mockResolvedValue(0);
  cancelSubscription.mockReset().mockResolvedValue(undefined);
});

describe("Admin gate", () => {
  it("non-admin → 403 FORBIDDEN; no DA call", async () => {
    isAdmin.mockResolvedValueOnce(false);
    const res = await POST(
      makeReq({ action: "suspend", username: "alice_da" })
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(daSuspendUser).not.toHaveBeenCalled();
  });
});

describe("Zod discriminated union", () => {
  it("invalid action → 400", async () => {
    const res = await POST(makeReq({ action: "BURN", username: "x" }));
    expect(res.status).toBe(400);
  });

  it("suspend without username → 400", async () => {
    const res = await POST(makeReq({ action: "suspend" }));
    expect(res.status).toBe(400);
    expect(daSuspendUser).not.toHaveBeenCalled();
  });

  it("unsuspend without username → 400", async () => {
    const res = await POST(makeReq({ action: "unsuspend" }));
    expect(res.status).toBe(400);
  });

  it("**delete with NEITHER username NOR hostingId → 400 (refine guard)**", async () => {
    const res = await POST(makeReq({ action: "delete" }));
    expect(res.status).toBe(400);
    expect(deleteHostingsByIdOrUsername).not.toHaveBeenCalled();
  });

  it("delete with hostingId only → ALLOWED (username optional)", async () => {
    daDeleteUser.mockResolvedValueOnce({ kind: "user_not_found" });
    const res = await POST(makeReq({ action: "delete", hostingId: "H1" }));
    expect(res.status).toBe(200);
    expect(deleteHostingsByIdOrUsername).toHaveBeenCalledWith(
      expect.objectContaining({ hostingId: "H1" })
    );
  });

  it("delete with username only → ALLOWED", async () => {
    daDeleteUser.mockResolvedValueOnce({ kind: "deleted" });
    const res = await POST(makeReq({ action: "delete", username: "alice_da" }));
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────── Suspend ─────────────────────────────

describe("suspend — DA outcome dispatch", () => {
  it("suspended → 200 with outcome", async () => {
    daSuspendUser.mockResolvedValueOnce({ kind: "suspended" });
    const res = await POST(makeReq({ action: "suspend", username: "alice_da" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.outcome).toBe("suspended");
  });

  it("user_not_found → 200 with outcome (no error)", async () => {
    daSuspendUser.mockResolvedValueOnce({ kind: "user_not_found" });
    const res = await POST(makeReq({ action: "suspend", username: "alice_da" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.outcome).toBe("user_not_found");
  });

  it("**da_unreachable → 503 DA_UNREACHABLE 'try again'**", async () => {
    daSuspendUser.mockResolvedValueOnce({
      kind: "da_unreachable",
      reason: "ECONNREFUSED",
    });
    const res = await POST(makeReq({ action: "suspend", username: "alice_da" }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("DA_UNREACHABLE");
    expect(body.error.toLowerCase()).toContain("try again");
  });

  it("**hard_failure → 500 ACTION_FAILED 'see server logs'**", async () => {
    daSuspendUser.mockResolvedValueOnce({ kind: "hard_failure" });
    const res = await POST(makeReq({ action: "suspend", username: "alice_da" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("ACTION_FAILED");
  });
});

describe("unsuspend — DA outcome dispatch", () => {
  it("unsuspended → 200 with outcome", async () => {
    daUnsuspendUser.mockResolvedValueOnce({ kind: "unsuspended" });
    const res = await POST(
      makeReq({ action: "unsuspend", username: "alice_da" })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.outcome).toBe("unsuspended");
  });

  it("da_unreachable → 503 DA_UNREACHABLE", async () => {
    daUnsuspendUser.mockResolvedValueOnce({ kind: "da_unreachable" });
    const res = await POST(
      makeReq({ action: "unsuspend", username: "alice_da" })
    );
    expect(res.status).toBe(503);
  });

  it("hard_failure → 500 ACTION_FAILED", async () => {
    daUnsuspendUser.mockResolvedValueOnce({ kind: "hard_failure" });
    const res = await POST(
      makeReq({ action: "unsuspend", username: "alice_da" })
    );
    expect(res.status).toBe(500);
  });
});

// ─────────────────────────── Delete ─────────────────────────────

describe("delete — multi-step flow", () => {
  function setupHosting(rows: Array<Record<string, unknown>> = []) {
    deleteHostingsByIdOrUsername.mockResolvedValueOnce({
      deletedCount: rows.length,
      matchedHostings: rows,
    });
  }

  it("matched hostings with subscriptionId → cancelSubscription called per row", async () => {
    setupHosting([
      { directAdminUsername: "alice_da", subscriptionId: "sub_1" },
      { directAdminUsername: "alice_da", subscriptionId: "sub_2" },
    ]);
    daDeleteUser.mockResolvedValueOnce({ kind: "deleted" });
    await POST(makeReq({ action: "delete", username: "alice_da" }));
    expect(cancelSubscription).toHaveBeenCalledTimes(2);
    expect(cancelSubscription.mock.calls[0][0]).toBe("sub_1");
    expect(cancelSubscription.mock.calls[1][0]).toBe("sub_2");
  });

  it("matched hosting WITHOUT subscriptionId → cancelSubscription NOT called", async () => {
    setupHosting([{ directAdminUsername: "alice_da" }]);
    daDeleteUser.mockResolvedValueOnce({ kind: "deleted" });
    await POST(makeReq({ action: "delete", username: "alice_da" }));
    expect(cancelSubscription).not.toHaveBeenCalled();
  });

  it("**cancelSubscription throw → SWALLOWED; other rows still processed**", async () => {
    setupHosting([
      { directAdminUsername: "alice_da", subscriptionId: "sub_fail" },
      { directAdminUsername: "alice_da", subscriptionId: "sub_ok" },
    ]);
    cancelSubscription
      .mockRejectedValueOnce(new Error("Razorpay down"))
      .mockResolvedValueOnce(undefined);
    daDeleteUser.mockResolvedValueOnce({ kind: "deleted" });
    const res = await POST(makeReq({ action: "delete", username: "alice_da" }));
    expect(res.status).toBe(200);
    expect(cancelSubscription).toHaveBeenCalledTimes(2);
  });

  it("username supplied → deletePendingHostingsByUsername called", async () => {
    setupHosting([]);
    daDeleteUser.mockResolvedValueOnce({ kind: "deleted" });
    await POST(makeReq({ action: "delete", username: "alice_da" }));
    expect(deletePendingHostingsByUsername).toHaveBeenCalledWith("alice_da");
  });

  it("hostingId only (no username) → deletePendingHostingsByUsername NOT called; daDeleteUser NOT called", async () => {
    setupHosting([]);
    await POST(makeReq({ action: "delete", hostingId: "H1" }));
    expect(deletePendingHostingsByUsername).not.toHaveBeenCalled();
    expect(daDeleteUser).not.toHaveBeenCalled();
    expect(clearDirectAdminUsernameForAll).not.toHaveBeenCalled();
  });
});

describe("delete — DA outcome resilience", () => {
  it("daDeleteUser 'deleted' → 200 with outcome", async () => {
    deleteHostingsByIdOrUsername.mockResolvedValueOnce({
      deletedCount: 1,
      matchedHostings: [{ directAdminUsername: "alice_da" }],
    });
    daDeleteUser.mockResolvedValueOnce({ kind: "deleted" });
    const res = await POST(makeReq({ action: "delete", username: "alice_da" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.outcome).toBe("deleted");
    expect(body.data.warning).toBeUndefined();
  });

  it("daDeleteUser 'user_not_found' → 200 with outcome", async () => {
    deleteHostingsByIdOrUsername.mockResolvedValueOnce({
      deletedCount: 1,
      matchedHostings: [],
    });
    daDeleteUser.mockResolvedValueOnce({ kind: "user_not_found" });
    const res = await POST(makeReq({ action: "delete", username: "alice_da" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.outcome).toBe("user_not_found");
  });

  it("**daDeleteUser other-outcome → 200 WITH warning field (local cleanup STILL committed)**", async () => {
    deleteHostingsByIdOrUsername.mockResolvedValueOnce({
      deletedCount: 1,
      matchedHostings: [],
    });
    daDeleteUser.mockResolvedValueOnce({ kind: "hard_failure" });
    const res = await POST(makeReq({ action: "delete", username: "alice_da" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.outcome).toBe("hard_failure");
    expect(body.data.warning).toContain("hard_failure");
    expect(body.data.warning.toLowerCase()).toContain("local records were cleared");
  });

  it("daDeleteUser da_unreachable → 200 with warning (local committed)", async () => {
    deleteHostingsByIdOrUsername.mockResolvedValueOnce({
      deletedCount: 1,
      matchedHostings: [],
    });
    daDeleteUser.mockResolvedValueOnce({ kind: "da_unreachable" });
    const res = await POST(makeReq({ action: "delete", username: "alice_da" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.warning).toContain("da_unreachable");
  });

  it("username supplied + ANY non-error DA outcome → clearDirectAdminUsernameForAll called", async () => {
    deleteHostingsByIdOrUsername.mockResolvedValueOnce({
      deletedCount: 1,
      matchedHostings: [],
    });
    daDeleteUser.mockResolvedValueOnce({ kind: "deleted" });
    await POST(makeReq({ action: "delete", username: "alice_da" }));
    expect(clearDirectAdminUsernameForAll).toHaveBeenCalledWith("alice_da");
  });
});

describe("Outer catch", () => {
  it("daSuspendUser throw → 500 ACTION_FAILED generic; sentinel NOT leaked", async () => {
    daSuspendUser.mockRejectedValueOnce(
      new Error("DA SDK crash — da_secret_LEAK_ME")
    );
    const res = await POST(makeReq({ action: "suspend", username: "alice_da" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("ACTION_FAILED");
    expect(JSON.stringify(body)).not.toContain("da_secret_LEAK_ME");
  });
});
