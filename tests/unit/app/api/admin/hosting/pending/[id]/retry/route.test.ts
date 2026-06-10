/**
 * Tests for `app/api/admin/hosting/pending/[id]/retry/route.ts`
 * (slice 7gr, part 2). Manual admin retry for a stuck
 * PendingHosting row. Delegates to provisionPendingHosting — the
 * SAME code path the auto-retry cron uses, so admin-triggered and
 * cron-triggered retries stay in sync.
 *
 * Pins:
 *  - Admin gate via isAdmin → 403 'Unauthorized. Admin access
 *    required.'
 *  - getPendingHostingById(id) → 404 NOT_FOUND when null
 *  - **provisionPendingHosting called with the FULL pending entry
 *    object** (not just the id) — this is the same arg shape the
 *    cron uses; a refactor that passes id-only would silently
 *    drift admin retries from the cron path
 *  - result.ok === false → 500 PROVISION_RETRY_FAILED with
 *    result.error (or 'Retry failed' fallback)
 *  - **result.dropped branch**: success message "User already had
 *    hosting elsewhere — pending entry cleared." (pinned because
 *    the dropped vs provisioned messages tell admin two different
 *    things about the customer's state)
 *  - result.ok + !dropped → "Hosting provisioned for ${domain}.
 *    Pending entry removed." (with domain interpolated)
 *  - Outer catch → 500 PROVISION_RETRY_FAILED with error.message
 *    LEAKED (matches sibling DELETE quirk)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const isAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { isAdmin },
}));

const getPendingHostingById = vi.hoisted(() => vi.fn());
const provisionPendingHosting = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/pending-hostings", () => ({
  getPendingHostingById,
  provisionPendingHosting,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/admin/hosting/pending/[id]/retry/route";

function makeReq() {
  return new NextRequest(
    "https://example.com/api/admin/hosting/pending/P1/retry",
    { method: "POST" }
  );
}

function paramsOf(id: string) {
  return { params: Promise.resolve({ id }) };
}

const samplePending = {
  _id: "P1",
  domain: "stuck.example.com",
  userId: "U1",
  daUsername: "stuck1",
  package: "starter",
  status: "failed",
};

beforeEach(() => {
  isAdmin.mockReset();
  getPendingHostingById.mockReset();
  provisionPendingHosting.mockReset();
});

describe("Admin gate (403)", () => {
  it("non-admin → 403 with 'Admin access required'; NO further calls", async () => {
    isAdmin.mockResolvedValueOnce(false);
    const res = await POST(makeReq(), paramsOf("P1"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("FORBIDDEN");
    expect(body.error).toContain("Admin access required");
    expect(getPendingHostingById).not.toHaveBeenCalled();
    expect(provisionPendingHosting).not.toHaveBeenCalled();
  });
});

describe("Pending entry lookup", () => {
  it("getPendingHostingById null → 404 NOT_FOUND 'Pending entry not found'", async () => {
    isAdmin.mockResolvedValueOnce(true);
    getPendingHostingById.mockResolvedValueOnce(null);
    const res = await POST(makeReq(), paramsOf("P_MISSING"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
    expect(body.error).toBe("Pending entry not found");
    expect(provisionPendingHosting).not.toHaveBeenCalled();
  });
});

describe("provisionPendingHosting call shape", () => {
  it("called with the FULL pending entry (not just id) — matches cron-path arg", async () => {
    isAdmin.mockResolvedValueOnce(true);
    getPendingHostingById.mockResolvedValueOnce(samplePending);
    provisionPendingHosting.mockResolvedValueOnce({
      ok: true,
      dropped: false,
    });
    await POST(makeReq(), paramsOf("P1"));
    expect(provisionPendingHosting).toHaveBeenCalledWith(samplePending);
  });
});

describe("result.ok === false → retry failure", () => {
  it("with result.error → 500 PROVISION_RETRY_FAILED + that error message", async () => {
    isAdmin.mockResolvedValueOnce(true);
    getPendingHostingById.mockResolvedValueOnce(samplePending);
    provisionPendingHosting.mockResolvedValueOnce({
      ok: false,
      error: "DA returned 503",
    });
    const res = await POST(makeReq(), paramsOf("P1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("PROVISION_RETRY_FAILED");
    expect(body.error).toBe("DA returned 503");
  });

  it("without result.error → fallback 'Retry failed' message", async () => {
    isAdmin.mockResolvedValueOnce(true);
    getPendingHostingById.mockResolvedValueOnce(samplePending);
    provisionPendingHosting.mockResolvedValueOnce({ ok: false });
    const res = await POST(makeReq(), paramsOf("P1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Retry failed");
  });
});

describe("result.ok branches — dropped vs provisioned", () => {
  it("result.dropped === true → 'User already had hosting elsewhere' success message (NO provisioning happened, entry cleared)", async () => {
    isAdmin.mockResolvedValueOnce(true);
    getPendingHostingById.mockResolvedValueOnce(samplePending);
    provisionPendingHosting.mockResolvedValueOnce({
      ok: true,
      dropped: true,
    });
    const res = await POST(makeReq(), paramsOf("P1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      message:
        "User already had hosting elsewhere — pending entry cleared.",
    });
  });

  it("result.dropped === false → 'Hosting provisioned for <domain>. Pending entry removed.' (with domain interpolated)", async () => {
    isAdmin.mockResolvedValueOnce(true);
    getPendingHostingById.mockResolvedValueOnce({
      ...samplePending,
      domain: "newshop.com",
    });
    provisionPendingHosting.mockResolvedValueOnce({
      ok: true,
      dropped: false,
    });
    const res = await POST(makeReq(), paramsOf("P1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe(
      "Hosting provisioned for newshop.com. Pending entry removed."
    );
  });
});

describe("Outer catch — leaks error.message (matches sibling DELETE)", () => {
  it("Error instance throw → 500 PROVISION_RETRY_FAILED + raw error.message", async () => {
    isAdmin.mockResolvedValueOnce(true);
    getPendingHostingById.mockRejectedValueOnce(
      new Error("Mongo: connection refused on shard-2")
    );
    const res = await POST(makeReq(), paramsOf("P1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("PROVISION_RETRY_FAILED");
    expect(body.error).toBe("Mongo: connection refused on shard-2");
  });

  it("non-Error throw → 'Failed to retry provision' fallback", async () => {
    isAdmin.mockResolvedValueOnce(true);
    getPendingHostingById.mockRejectedValueOnce("just-string");
    const res = await POST(makeReq(), paramsOf("P1"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to retry provision");
  });
});
