/**
 * Tests for `app/api/admin/resellerclub/balance/route.ts` (slice
 * 7gs, part 1). Admin view of the ResellerClub reseller account
 * (wallet balance + status).
 *
 * Pins:
 *  - Admin gate via getAdminFromRequest → 401 'Unauthorized'
 *    (matches 7gp ip-status — uses 401, not 403)
 *  - ResellerClubAPI.getResellerDetails() called with NO args
 *  - **status !== 'success' OR no data** → 502 RC_FETCH_FAILED
 *    (502, NOT 500 — distinguishes upstream RC outage from a
 *    local bug; matches the convention used for upstream-API
 *    failure in other admin RC routes)
 *  - **Prepaid vs NoBilling branch**:
 *    - billingMode 'NoBilling' (credit account) → hasPrepaidWallet
 *      false; available / unutilised / locked are NULL (NOT 0 —
 *      'no wallet at all' is distinct from '0 rupees')
 *    - billingMode 'Prepaid' (or anything else != 'NoBilling') →
 *      hasPrepaidWallet true; parseFloat with '0' fallback on
 *      each balance field
 *  - **Defaults pinned**: name='', resellerId='', accountStatus=
 *    'Unknown', billingMode='Unknown' (when RC returns the data
 *    object but a field is missing — no crash, no client null)
 *  - totalReceipts always present (parseFloat with '0' fallback —
 *    even on NoBilling accounts)
 *  - Outer catch → 500 INTERNAL_ERROR 'Internal error' (no leak;
 *    RC error messages can contain reseller IDs / API key fragments)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { getAdminFromRequest },
}));

const getResellerDetails = vi.hoisted(() => vi.fn());
vi.mock("@/lib/resellerclub", () => ({
  ResellerClubAPI: { getResellerDetails },
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/admin/resellerclub/balance/route";

function makeReq() {
  return new NextRequest(
    "https://example.com/api/admin/resellerclub/balance",
    { method: "GET" }
  );
}

beforeEach(() => {
  getAdminFromRequest.mockReset();
  getResellerDetails.mockReset();
});

describe("Admin gate (401)", () => {
  it("non-admin → 401 UNAUTHORIZED; NO RC call", async () => {
    getAdminFromRequest.mockResolvedValueOnce(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("UNAUTHORIZED");
    expect(getResellerDetails).not.toHaveBeenCalled();
  });
});

describe("RC fetch failure → 502 (NOT 500 — upstream-outage marker)", () => {
  it("status !== 'success' → 502 RC_FETCH_FAILED", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    getResellerDetails.mockResolvedValueOnce({
      status: "error",
      error: "RC API 500: upstream timeout",
    });
    const res = await GET(makeReq());
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe("RC_FETCH_FAILED");
    expect(body.error).toBe("Failed to fetch ResellerClub account details");
  });

  it("status:success but data missing → 502", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    getResellerDetails.mockResolvedValueOnce({ status: "success" });
    const res = await GET(makeReq());
    expect(res.status).toBe(502);
  });
});

describe("Prepaid wallet — happy path", () => {
  it("Prepaid account → hasPrepaidWallet:true; balances parsed as floats", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    getResellerDetails.mockResolvedValueOnce({
      status: "success",
      data: {
        name: "Anutech",
        resellerid: "RC_12345",
        resellerstatus: "Active",
        billingmode: "Prepaid",
        availablebalance: "15234.50",
        unutilisedsellingbalance: "10000.00",
        lockedbalance: "234.50",
        totalreceipts: "99999.99",
      },
    });
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      account: {
        name: "Anutech",
        resellerId: "RC_12345",
        accountStatus: "Active",
        billingMode: "Prepaid",
        hasPrepaidWallet: true,
        available: 15234.5,
        unutilised: 10000,
        locked: 234.5,
        totalReceipts: 99999.99,
      },
    });
  });

  it("Prepaid + missing balance fields → parseFloat('0') = 0 (not NaN)", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    getResellerDetails.mockResolvedValueOnce({
      status: "success",
      data: {
        name: "Anutech",
        resellerid: "RC1",
        resellerstatus: "Active",
        billingmode: "Prepaid",
        // No balance fields at all
      },
    });
    const body = await (await GET(makeReq())).json();
    expect(body.account.available).toBe(0);
    expect(body.account.unutilised).toBe(0);
    expect(body.account.locked).toBe(0);
    expect(body.account.totalReceipts).toBe(0);
  });
});

describe("NoBilling (credit) account — wallet fields are NULL not 0", () => {
  it("billingMode 'NoBilling' → hasPrepaidWallet:false; available/unutilised/locked are NULL", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    getResellerDetails.mockResolvedValueOnce({
      status: "success",
      data: {
        name: "CreditAcct",
        resellerid: "RC_CREDIT_1",
        resellerstatus: "Active",
        billingmode: "NoBilling",
        // Even if RC returned balance numbers, they should still be NULL
        // because hasPrepaidWallet=false
        availablebalance: "999",
        unutilisedsellingbalance: "888",
        lockedbalance: "777",
        totalreceipts: "5000",
      },
    });
    const body = await (await GET(makeReq())).json();
    expect(body.account.hasPrepaidWallet).toBe(false);
    expect(body.account.available).toBeNull();
    expect(body.account.unutilised).toBeNull();
    expect(body.account.locked).toBeNull();
    // totalReceipts is STILL populated on NoBilling accounts (it's a
    // separate concept from the wallet)
    expect(body.account.totalReceipts).toBe(5000);
  });
});

describe("Defaults for missing top-level fields", () => {
  it("name / resellerid / resellerstatus / billingmode all missing → 'Unknown' defaults + empty strings", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    getResellerDetails.mockResolvedValueOnce({
      status: "success",
      data: {},
    });
    const body = await (await GET(makeReq())).json();
    expect(body.account.name).toBe("");
    expect(body.account.resellerId).toBe("");
    expect(body.account.accountStatus).toBe("Unknown");
    expect(body.account.billingMode).toBe("Unknown");
    // No billingmode means !== 'NoBilling' so prepaid path is taken
    expect(body.account.hasPrepaidWallet).toBe(true);
  });
});

describe("Outer catch", () => {
  it("RC throw → 500 INTERNAL_ERROR generic (no RC error fragment leak)", async () => {
    getAdminFromRequest.mockResolvedValueOnce({ _id: "A1" });
    getResellerDetails.mockRejectedValueOnce(
      new Error("RC api-key=apk_TESTKEY_LEAK_ME invalid sig")
    );
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.error).toBe("Internal error");
    expect(body.error).not.toContain("apk_TESTKEY");
    expect(body.error).not.toContain("api-key");
  });
});
