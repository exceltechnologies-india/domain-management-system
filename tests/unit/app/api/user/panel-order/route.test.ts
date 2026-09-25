/**
 * app/api/user/panel-order — the panel dialogs' way to start a paid purchase
 * (owner decision 30, 25 Sep 2026: ResellerOS creates every Razorpay order).
 *
 * Pinned:
 *  - signed out → 401, and ResellerOS is not called;
 *  - identity sent to ResellerOS is the SESSION user's, whatever the body says;
 *  - ResellerOS unreachable → 503 with a message that says nothing was charged,
 *    and `mayHaveCreated` passed through; never a 401 (which would sign the
 *    customer out), never a DMS fallback;
 *  - nothing is written locally: the route and its lib import no model, no
 *    order service and no Razorpay client (source scan, comments stripped).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ AuthService: { getUserFromRequest } }));

const createPanelOrder = vi.hoisted(() => vi.fn());
vi.mock("@/lib/reselleros/panel-order", async (orig) => ({
  ...(await orig<typeof import("@/lib/reselleros/panel-order")>()),
  createPanelOrder,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<typeof import("next/server")>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET, POST } from "@/app/api/user/panel-order/route";

const USER = {
  _id: "65f0c0ffee0000000000abcd",
  email: "asha@example.test",
  firstName: "Asha",
  lastName: "Rao",
  phone: "9876543210",
  companyName: "Rao Traders",
  gstNumber: "",
  address: { line1: "1 MG Road", city: "Delhi", state: "Delhi", zipcode: "110001", country: "India" },
};

function post(body: unknown) {
  return new NextRequest("https://dms.example.test/api/user/panel-order", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const HOSTING = {
  purchase: { kind: "hosting", planId: "starter", cycle: "yearly", domain: "rao.in" },
  companyName: "Rao Traders",
};

beforeEach(() => {
  getUserFromRequest.mockReset();
  createPanelOrder.mockReset();
});

describe("POST /api/user/panel-order", () => {
  it("signed out: 401 and ResellerOS is never asked", async () => {
    getUserFromRequest.mockResolvedValue(null);
    const res = await POST(post(HOSTING));
    expect(res.status).toBe(401);
    expect(createPanelOrder).not.toHaveBeenCalled();
  });

  it("identity comes from the session, not the body", async () => {
    getUserFromRequest.mockResolvedValue(USER);
    createPanelOrder.mockResolvedValue({
      kind: "ok",
      order: { orderId: "order_X", amount: 70800, currency: "INR", razorpayKeyId: "rzp_test_k", quoteId: "Q-1", totalRupees: 708 },
    });
    const res = await POST(post({ ...HOSTING, email: "mallory@example.test", dmsUserId: "x", phone: "1111111111" }));
    expect(res.status).toBe(200);
    const sent = createPanelOrder.mock.calls[0][0];
    expect(sent).toMatchObject({ dmsUserId: USER._id, email: USER.email, fullName: "Asha Rao", phone: USER.phone });
    const body = await res.json();
    expect(body).toMatchObject({ success: true, orderId: "order_X", razorpayKeyId: "rzp_test_k", quoteId: "Q-1" });
  });

  it("ResellerOS unreachable: 503, nothing charged, never retried", async () => {
    getUserFromRequest.mockResolvedValue(USER);
    createPanelOrder.mockResolvedValue({ kind: "unreachable", detail: "ECONNREFUSED", mayHaveCreated: false });
    const res = await POST(post(HOSTING));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("RESELLEROS_UNREACHABLE");
    expect(body.mayHaveCreated).toBe(false);
    expect(body.error).toMatch(/Nothing was charged/);
    expect(createPanelOrder).toHaveBeenCalledTimes(1);
  });

  it("a timeout tells the customer to check before retrying", async () => {
    getUserFromRequest.mockResolvedValue(USER);
    createPanelOrder.mockResolvedValue({ kind: "unreachable", detail: "TimeoutError", mayHaveCreated: true });
    const body = await (await POST(post(HOSTING))).json();
    expect(body.mayHaveCreated).toBe(true);
    expect(body.error).toMatch(/before trying again/);
  });

  it("ResellerOS refusing OUR key is a 503, never a 401 that would sign the customer out", async () => {
    getUserFromRequest.mockResolvedValue(USER);
    createPanelOrder.mockResolvedValue({ kind: "config", status: 401, detail: "bad key" });
    const res = await POST(post(HOSTING));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("PANEL_ORDER_UNAVAILABLE");
  });

  it("DMS not configured: 503 with a clear message", async () => {
    getUserFromRequest.mockResolvedValue(USER);
    createPanelOrder.mockResolvedValue({ kind: "not_configured", missing: ["DMS_PANEL_API_KEY"] });
    const res = await POST(post(HOSTING));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/isn't available right now/);
  });

  it("a ResellerOS 400 is shown to the customer as written", async () => {
    getUserFromRequest.mockResolvedValue(USER);
    createPanelOrder.mockResolvedValue({ kind: "refused", message: "rao.in is taken. Nothing was charged.", needDomain: true });
    const res = await POST(post(HOSTING));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "rao.in is taken. Nothing was charged.", needDomain: true });
  });

  it("an account with no phone is refused before ResellerOS is asked", async () => {
    getUserFromRequest.mockResolvedValue({ ...USER, phone: "" });
    const res = await POST(post(HOSTING));
    expect(res.status).toBe(400);
    expect(createPanelOrder).not.toHaveBeenCalled();
  });
});

describe("GET /api/user/panel-order", () => {
  it("returns the saved billing details for the form", async () => {
    getUserFromRequest.mockResolvedValue(USER);
    const res = await GET(new NextRequest("https://dms.example.test/api/user/panel-order"));
    expect(await res.json()).toMatchObject({
      phoneOnFile: true,
      companyName: "Rao Traders",
      address: { line1: "1 MG Road", city: "Delhi", state: "Delhi", zipcode: "110001" },
    });
  });
});

describe("nothing is created in DMS on this path (source scan)", () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const files = [
    "app/api/user/panel-order/route.ts",
    "lib/reselleros/panel-order.ts",
    "lib/reselleros/panel-order-request.ts",
    "components/purchase/PanelCheckout.tsx",
  ];
  it.each(files)("%s imports no model, order service, Razorpay client or cart", (f) => {
    const src = strip(readFileSync(path.join(process.cwd(), f), "utf8"));
    expect(src).not.toMatch(/@\/models\//);
    expect(src).not.toMatch(/@\/lib\/services\/orders/);
    expect(src).not.toMatch(/@\/lib\/razorpay["']/);
    expect(src).not.toMatch(/cartStore/);
    expect(src).not.toMatch(/payments\/verify|payments\/create-order/);
  });
});
