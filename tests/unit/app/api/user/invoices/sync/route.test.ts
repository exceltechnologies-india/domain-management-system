/**
 * Tests for `app/api/user/invoices/sync/route.ts` (slice 7gs, part
 * 2). Customer-initiated reconciliation for paid orders whose
 * Zoho Books invoice never finished creating. Bypasses the
 * background self-heal throttle.
 *
 * The hazard with a manual sync button: a curious customer mashes
 * it. Idempotency is achieved at the syncUserInvoicesNow layer
 * (it searches Zoho by reference_number first), but the user-
 * scoping AND the categorise-by-outcome contract are this route's
 * job.
 *
 * Pins:
 *  - Auth gate FIRST → 401; NO sync call (no anonymous Zoho calls)
 *  - **syncUserInvoicesNow scoped on String(user._id)** — no
 *    cross-user reconciliation possible
 *  - Result categorisation: `recovered` = results with ok:true;
 *    `failed` = !ok AND !skipped; `skipped` = !!result.skipped
 *  - Response shape: { success, total, recovered, failed, skipped,
 *    results } with `total === results.length`
 *  - **Empty results array** → all counts 0; success still true
 *  - Outer catch → 500 with generic message "Invoice sync failed.
 *    Please try again or contact support." — NO raw Zoho error
 *    (Zoho exceptions can carry access-token fragments + retry
 *    tokens that don't belong in a user-facing response)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const syncUserInvoicesNow = vi.hoisted(() => vi.fn());
vi.mock("@/lib/zoho-invoice-retry", () => ({ syncUserInvoicesNow }));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/user/invoices/sync/route";

function makeReq() {
  return new NextRequest("https://example.com/api/user/invoices/sync", {
    method: "POST",
  });
}

const user = { _id: "U1", email: "alice@example.com" };

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(user);
  syncUserInvoicesNow.mockReset();
});

describe("Auth gate FIRST", () => {
  it("no user → 401 'Unauthorized'; NO sync call (no anonymous Zoho)", async () => {
    getUserFromRequest.mockResolvedValueOnce(null);
    const res = await POST(makeReq());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
    expect(syncUserInvoicesNow).not.toHaveBeenCalled();
  });
});

describe("IDOR — user-scoped reconciliation", () => {
  it("syncUserInvoicesNow called with String(user._id)", async () => {
    syncUserInvoicesNow.mockResolvedValueOnce([]);
    await POST(makeReq());
    expect(syncUserInvoicesNow).toHaveBeenCalledWith("U1");
  });
});

describe("Result categorisation", () => {
  it("ok:true → recovered; !ok && !skipped → failed; skipped:true → skipped", async () => {
    syncUserInvoicesNow.mockResolvedValueOnce([
      { orderId: "O1", ok: true },
      { orderId: "O2", ok: true },
      { orderId: "O3", ok: false },
      { orderId: "O4", ok: false, skipped: true },
      { orderId: "O5", skipped: true },
    ]);
    const res = await POST(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      total: 5,
      recovered: 2,
      failed: 1,
      skipped: 2,
      results: [
        { orderId: "O1", ok: true },
        { orderId: "O2", ok: true },
        { orderId: "O3", ok: false },
        { orderId: "O4", ok: false, skipped: true },
        { orderId: "O5", skipped: true },
      ],
    });
  });

  it("ok:true with skipped:true → counted as recovered (skipped flag overrides ONLY the failed bucket)", async () => {
    // Pin the current source order: failed counts `!ok && !skipped`,
    // so ok:true wins over skipped:true into 'recovered'. This is a
    // corner case worth pinning so a refactor that swaps the order
    // is flagged.
    syncUserInvoicesNow.mockResolvedValueOnce([
      { orderId: "O1", ok: true, skipped: true },
    ]);
    const body = await (await POST(makeReq())).json();
    expect(body.recovered).toBe(1);
    expect(body.skipped).toBe(1); // also counted as skipped (skipped bucket uses ONLY skipped flag)
    expect(body.failed).toBe(0);
  });

  it("empty results array → all counts 0 with success still true", async () => {
    syncUserInvoicesNow.mockResolvedValueOnce([]);
    const res = await POST(makeReq());
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      total: 0,
      recovered: 0,
      failed: 0,
      skipped: 0,
      results: [],
    });
  });
});

describe("Outer catch — anti-Zoho-token-leak", () => {
  it("syncUserInvoicesNow throw → 500 with GENERIC message; raw Zoho fragments NOT leaked", async () => {
    syncUserInvoicesNow.mockRejectedValueOnce(
      new Error(
        "Zoho 401: access_token=zoho_oauth_LEAK_ME_PLEASE invalid, retry_token=rt_abc123"
      )
    );
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe(
      "Invoice sync failed. Please try again or contact support."
    );
    expect(body.error).not.toContain("zoho_oauth_LEAK");
    expect(body.error).not.toContain("retry_token");
    expect(body.error).not.toContain("access_token");
  });
});
