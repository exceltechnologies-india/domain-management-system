/**
 * app/api/user/renewal-order — pay a ResellerOS renewal bill inside the panel (owner, 28 Sep 2026).
 *
 * Pinned: signed out → 401 and ResellerOS is not called; the identity sent is the SESSION's,
 * whatever the body says; ResellerOS's refusal is passed through (409 stays 409); a key or
 * config fault is 503, never 401 (lib/api-client.ts would sign the customer out); nothing is
 * written locally (no model, no order service, no Razorpay client — source scan).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ AuthService: { getUserFromRequest } }));

const createRenewalOrder = vi.hoisted(() => vi.fn());
vi.mock("@/lib/reselleros/renewal-order", async (orig) => ({
  ...(await orig<typeof import("@/lib/reselleros/renewal-order")>()),
  createRenewalOrder,
}));
vi.mock("@/lib/server-logger", () => ({ serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<typeof import("next/server")>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/user/renewal-order/route";

const USER = { _id: "65f0c0ffee0000000000abcd", email: "asha@example.test", firstName: "Asha", lastName: "Rao", phone: "9876543210" };
const post = (body: unknown) =>
  new NextRequest("https://dms.example.test/api/user/renewal-order", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(USER);
  createRenewalOrder.mockReset();
});

describe("POST /api/user/renewal-order", () => {
  it("signed out → 401, ResellerOS not called", async () => {
    getUserFromRequest.mockResolvedValue(null);
    expect((await POST(post({ quoteId: "Q-R-1" }))).status).toBe(401);
    expect(createRenewalOrder).not.toHaveBeenCalled();
  });

  it("sends the session's email and account, never the body's", async () => {
    createRenewalOrder.mockResolvedValue({ kind: "ok", order: { orderId: "order_R", amount: 70800, currency: "INR", razorpayKeyId: "k", quoteId: "Q-R-1" } });
    const res = await POST(post({ quoteId: "Q-R-1", email: "attacker@example.test", dmsUserId: "someone-else" }));
    expect(res.status).toBe(200);
    expect(createRenewalOrder).toHaveBeenCalledWith({ quoteId: "Q-R-1", email: "asha@example.test", dmsUserId: USER._id });
    expect(await res.json()).toMatchObject({ orderId: "order_R", razorpayKeyId: "k", prefill: { email: "asha@example.test" } });
  });

  it("a malformed quote id → 400, ResellerOS not called", async () => {
    expect((await POST(post({ quoteId: "../../x" }))).status).toBe(400);
    expect(createRenewalOrder).not.toHaveBeenCalled();
  });

  it("ResellerOS's refusal is shown as written; already-paid stays 409", async () => {
    createRenewalOrder.mockResolvedValue({ kind: "refused", status: 409, message: "This quote is already paid." });
    const res = await POST(post({ quoteId: "Q-R-1" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This quote is already paid.");
  });

  it.each([
    { kind: "config", status: 401, detail: "bad key" },
    { kind: "not_configured", missing: ["DMS_PANEL_API_KEY"] },
    { kind: "unreachable", detail: "timeout" },
  ])("$kind → 503 saying nothing was charged, never 401", async (outcome) => {
    createRenewalOrder.mockResolvedValue(outcome);
    const res = await POST(post({ quoteId: "Q-R-1" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/Nothing was charged/);
  });

  it("writes nothing locally (source scan, comments stripped)", () => {
    for (const f of ["app/api/user/renewal-order/route.ts", "lib/reselleros/renewal-order.ts"]) {
      const code = readFileSync(path.join(process.cwd(), f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(code).not.toMatch(/@\/models\/|services\/orders|from ["']razorpay["']|lib\/razorpay/);
    }
  });
});
