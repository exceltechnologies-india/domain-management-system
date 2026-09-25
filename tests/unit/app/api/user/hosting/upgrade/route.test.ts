/**
 * Tests for `app/api/user/hosting/upgrade/route.ts` — since 25 Sep 2026 an
 * upgrade REQUEST sent to ResellerOS (owner: "Request, billed by ResellerOS").
 *
 * Pinned:
 *  - Auth → 401; per-user rate-limit; the eligibility checks are unchanged
 *    (owner's hosting only, active, not expired, target plan higher)
 *  - NOTHING is created in DMS and no Razorpay order: the route imports no
 *    order service and no Razorpay client (source scan, comments stripped)
 *  - identity sent to ResellerOS is the session user's, never the body's
 *  - estimateRupees is the SERVER's proration on ResellerOS's prices, an int;
 *    a body amount is ignored; an unpriced plan sends no estimate at all
 *  - a timeout says the request may have been recorded; nothing is retried
 *  - ResellerOS refusing our key → 503, never 401
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ AuthService: { getUserFromRequest } }));

const checkKey = vi.hoisted(() => vi.fn());
vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit")>("@/lib/rate-limit");
  return { ...actual, rateLimiters: { hostingRenewUpgrade: { checkKey } } };
});

const findUserHosting = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hostings", () => ({ findUserHosting }));

const getPlanByPlanId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hosting-plans", () => ({ getPlanByPlanId }));

const sendUpgradeRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/reselleros/upgrade-request", async (orig) => ({
  ...(await orig<typeof import("@/lib/reselleros/upgrade-request")>()),
  sendUpgradeRequest,
}));

vi.mock("@/lib/server-logger", () => ({ serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<typeof import("next/server")>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/user/hosting/upgrade/route";

const makeReq = (body: unknown) =>
  new NextRequest("https://example.com/api/user/hosting/upgrade", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const USER = { _id: "U1", email: "alice@example.com", firstName: "Alice", lastName: "Smith", phone: "9876543210", companyName: "Acme" };
const VALID = { domainName: "example.com", targetPlanId: "plus" };
const EXPIRY = new Date(Date.now() + 15 * 86_400_000);

function setupHappy(currentPlanId = "starter", targetPlanId = "plus") {
  getUserFromRequest.mockResolvedValue(USER);
  checkKey.mockResolvedValue({ allowed: true });
  findUserHosting.mockResolvedValue({ _id: "H1", domainName: "example.com", status: "active", planId: currentPlanId, expiryDate: EXPIRY });
  getPlanByPlanId
    // Deliberately nonsense Mongo prices: they must not be read.
    .mockResolvedValueOnce({ planId: currentPlanId, name: "Current", price: 1 })
    .mockResolvedValueOnce({ planId: targetPlanId, name: "Plus", price: 1 });
  sendUpgradeRequest.mockResolvedValue({ kind: "ok", leadId: "L-1", alreadyRequested: false });
}

beforeEach(() => {
  getUserFromRequest.mockReset();
  checkKey.mockReset();
  findUserHosting.mockReset();
  getPlanByPlanId.mockReset();
  sendUpgradeRequest.mockReset();
});

describe("gates (unchanged)", () => {
  it("signed out → 401; ResellerOS not asked", async () => {
    getUserFromRequest.mockResolvedValue(null);
    expect((await POST(makeReq(VALID))).status).toBe(401);
    expect(sendUpgradeRequest).not.toHaveBeenCalled();
  });

  it("rate-limited per user", async () => {
    getUserFromRequest.mockResolvedValue(USER);
    checkKey.mockResolvedValue({ allowed: false, remaining: 0, resetTime: Date.now() + 60_000 });
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(429);
    expect(checkKey).toHaveBeenCalledWith("hosting_upgrade:U1");
  });

  it("another customer's hosting → 404 (lookup keyed on the session user)", async () => {
    getUserFromRequest.mockResolvedValue(USER);
    checkKey.mockResolvedValue({ allowed: true });
    findUserHosting.mockResolvedValue(null);
    expect((await POST(makeReq(VALID))).status).toBe(404);
    expect(findUserHosting).toHaveBeenCalledWith("U1", { domainName: "example.com" });
  });

  it("not active → 400; expired → 400", async () => {
    getUserFromRequest.mockResolvedValue(USER);
    checkKey.mockResolvedValue({ allowed: true });
    findUserHosting.mockResolvedValueOnce({ status: "suspended", expiryDate: EXPIRY, planId: "starter" });
    expect((await POST(makeReq(VALID))).status).toBe(400);
    findUserHosting.mockResolvedValueOnce({ status: "active", expiryDate: new Date(Date.now() - 1000), planId: "starter" });
    expect((await POST(makeReq(VALID))).status).toBe(400);
    expect(sendUpgradeRequest).not.toHaveBeenCalled();
  });

  it("a downgrade is refused before ResellerOS is asked", async () => {
    setupHappy("plus", "starter");
    const res = await POST(makeReq({ ...VALID, targetPlanId: "starter" }));
    expect(res.status).toBe(400);
    expect(sendUpgradeRequest).not.toHaveBeenCalled();
  });
});

describe("the request", () => {
  it("identity from the session; estimate from the server's proration (int); a body amount is ignored", async () => {
    setupHappy();
    const res = await POST(makeReq({ ...VALID, email: "mallory@example.com", amount: 1, estimateRupees: 1 }));
    expect(res.status).toBe(200);
    const sent = sendUpgradeRequest.mock.calls[0][0];
    expect(sent).toMatchObject({
      dmsUserId: "U1",
      email: "alice@example.com",
      fullName: "Alice Smith",
      phone: "9876543210",
      companyName: "Acme",
      domain: "example.com",
      currentPlan: "starter",
      targetPlan: "plus",
      expiresAt: EXPIRY.toISOString(),
    });
    // Starter ₹708/yr, Plus ₹2,650/yr incl. GST; 15 days → (2650-708)/12 × 15/30 ≈ 81 → ₹100 floor.
    expect(sent.estimateRupees).toBe(100);
    expect(Number.isInteger(sent.estimateRupees)).toBe(true);
    expect(await res.json()).toMatchObject({ success: true, data: { leadId: "L-1", alreadyRequested: false, estimateRupees: 100 } });
  });

  it("a plan ResellerOS does not price → the request goes WITHOUT an estimate", async () => {
    setupHappy("starter", "25GB-wp");
    await POST(makeReq({ ...VALID, targetPlanId: "25GB-wp" }));
    expect(sendUpgradeRequest.mock.calls[0][0]).not.toHaveProperty("estimateRupees");
  });

  it("a timeout: 503, 'may have been recorded', sent once", async () => {
    setupHappy();
    sendUpgradeRequest.mockResolvedValue({ kind: "unreachable", detail: "TimeoutError", mayHaveRecorded: true });
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.mayHaveRecorded).toBe(true);
    expect(body.error).toMatch(/may have been recorded/);
    expect(sendUpgradeRequest).toHaveBeenCalledTimes(1);
  });

  it("ResellerOS refusing our key → 503, never 401", async () => {
    setupHappy();
    sendUpgradeRequest.mockResolvedValue({ kind: "config", status: 401, detail: "bad key" });
    expect((await POST(makeReq(VALID))).status).toBe(503);
  });

  it("a ResellerOS 400 is shown as written", async () => {
    setupHappy();
    sendUpgradeRequest.mockResolvedValue({ kind: "refused", message: "That domain has no hosting with us." });
    const res = await POST(makeReq(VALID));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("That domain has no hosting with us.");
  });
});

describe("creates nothing in DMS (source scan, comments stripped)", () => {
  it("imports no order service and no Razorpay client", () => {
    const code = readFileSync(path.join(process.cwd(), "app/api/user/hosting/upgrade/route.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/@\/lib\/services\/orders|@\/lib\/razorpay["']|createOrder/);
  });
});
