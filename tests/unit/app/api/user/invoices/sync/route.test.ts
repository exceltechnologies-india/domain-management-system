/**
 * Tests for `app/api/user/invoices/sync/route.ts`.
 * Customer-initiated retry for paid orders whose invoice attempt FAILED
 * (`invoiceFailedAt`, no `invoiceProvider`). Since Zoho Books was removed
 * (24 Sep 2026) it runs our own GST engine again via
 * `lib/invoice-retry`'s syncUserInvoicesNow, bypassing the self-heal
 * throttle.
 *
 * The hazard with a manual sync button: a curious customer mashes it.
 * Idempotency is the engine claim's job (it refuses any order that already
 * has an invoiceProvider); user-scoping and the categorise-by-outcome
 * contract are this route's.
 *
 * Pins:
 *  - Auth gate FIRST → 401; NO sync call
 *  - **syncUserInvoicesNow scoped on String(user._id)**
 *  - Result categorisation: `recovered` = ok:true; `failed` = !ok AND
 *    !skipped; `skipped` = !!skipped (reasons: throttled / already_done /
 *    no_user / no_order)
 *  - Response shape: { success, total, recovered, failed, skipped,
 *    results } with `total === results.length`
 *  - Empty results → all counts 0; success still true
 *  - Outer catch → 500 with a generic message — no raw internal error
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getUserFromRequest },
}));

const syncUserInvoicesNow = vi.hoisted(() => vi.fn());
vi.mock("@/lib/invoice-retry", () => ({ syncUserInvoicesNow }));

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
  it("no user → 401 'Unauthorized'; NO sync call (no anonymous retries)", async () => {
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
  it("ok:true → recovered; !ok && !skipped → failed; any skipped reason → skipped", async () => {
    syncUserInvoicesNow.mockResolvedValueOnce([
      { orderId: "O1", ok: true },
      { orderId: "O2", ok: true },
      { orderId: "O3", ok: false },
      { orderId: "O4", ok: false, skipped: "already_done" },
      { orderId: "O5", ok: false, skipped: "no_order" },
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
        { orderId: "O4", ok: false, skipped: "already_done" },
        { orderId: "O5", ok: false, skipped: "no_order" },
      ],
    });
  });

  it("ok:true with a skipped reason → counted as recovered (skipped flag overrides ONLY the failed bucket)", async () => {
    // Pin the current source order: failed counts `!ok && !skipped`,
    // so ok:true wins over skipped:true into 'recovered'. This is a
    // corner case worth pinning so a refactor that swaps the order
    // is flagged.
    syncUserInvoicesNow.mockResolvedValueOnce([
      { orderId: "O1", ok: true, skipped: "throttled" },
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

describe("Outer catch — no internal-error leak", () => {
  it("syncUserInvoicesNow throw → 500 with GENERIC message; raw error fragments NOT leaked", async () => {
    syncUserInvoicesNow.mockRejectedValueOnce(
      new Error(
        "Mongo auth failed: access_token=db_LEAK_ME_PLEASE invalid, retry_token=rt_abc123"
      )
    );
    const res = await POST(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe(
      "Invoice sync failed. Please try again or contact support."
    );
    expect(body.error).not.toContain("db_LEAK");
    expect(body.error).not.toContain("retry_token");
    expect(body.error).not.toContain("access_token");
  });
});
