/**
 * GET /api/user/billing — the customer's ResellerOS bills. Pinned: the email
 * comes from the session; every non-ok read is `unavailable` with a message,
 * never an empty list; signed out → 401 and ResellerOS is not asked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ AuthService: { getUserFromRequest } }));

const fetchCustomerBills = vi.hoisted(() => vi.fn());
vi.mock("@/lib/reselleros/bills", async (orig) => ({
  ...(await orig<typeof import("@/lib/reselleros/bills")>()),
  fetchCustomerBills,
}));
vi.mock("@/lib/server-logger", () => ({ serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<typeof import("next/server")>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET } from "@/app/api/user/billing/route";

const req = () => new NextRequest("https://dms.example.test/api/user/billing");

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue({ _id: "U1", email: "asha@example.test" });
  fetchCustomerBills.mockReset();
});

describe("GET /api/user/billing", () => {
  it("signed out → 401, ResellerOS not asked", async () => {
    getUserFromRequest.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
    expect(fetchCustomerBills).not.toHaveBeenCalled();
  });

  it("looks up the SESSION user's email", async () => {
    fetchCustomerBills.mockResolvedValue({ kind: "no_bills" });
    await GET(req());
    expect(fetchCustomerBills).toHaveBeenCalledWith("asha@example.test");
  });

  it("ok → quotes + invoices", async () => {
    fetchCustomerBills.mockResolvedValue({ kind: "ok", customerId: "C-1", quotes: [{ id: "Q-1" }], invoices: [] });
    expect(await (await GET(req())).json()).toEqual({ state: "ok", quotes: [{ id: "Q-1" }], invoices: [] });
  });

  it("no_bills → state no_bills", async () => {
    fetchCustomerBills.mockResolvedValue({ kind: "no_bills" });
    expect(await (await GET(req())).json()).toEqual({ state: "no_bills" });
  });

  it.each([
    { kind: "unavailable", detail: "HTTP 500" },
    { kind: "not_configured", missing: ["RESELLEROS_BILLING_API_KEY"] },
    { kind: "not_confirmed", detail: "email mismatch" },
  ])("$kind → state unavailable with a message, and no lists", async (outcome) => {
    fetchCustomerBills.mockResolvedValue(outcome);
    const body = await (await GET(req())).json();
    expect(body.state).toBe("unavailable");
    expect(typeof body.message).toBe("string");
    expect(body).not.toHaveProperty("quotes");
    expect(body).not.toHaveProperty("invoices");
  });
});
