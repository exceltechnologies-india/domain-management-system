/**
 * app/api/user/hosting/start-trial — the ₹0 in-panel trial, split out of the
 * deleted api/payments/create-order (25 Sep 2026).
 *
 * Pinned: create-order's trial gates, unchanged (lone trial line, domain,
 * Starter only, cycle, trials enabled, one per user, one per customer across
 * both apps — unreadable history refuses, abuse checks, claim recorded);
 * a ₹0 hosting_trial Order + a manual trial Hosting; and NO Razorpay call
 * anywhere (source scan, comments stripped).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ AuthService: { getUserFromRequest } }));

const createOrder = vi.hoisted(() => vi.fn());
const userHasPriorTrialOrder = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/orders", () => ({ createOrder, userHasPriorTrialOrder }));

const createManualFlowTrialHosting = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/payment/manual-trial-provisioner", () => ({ createManualFlowTrialHosting }));

const getPlanByPlanId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hosting-plans", () => ({ getPlanByPlanId }));

const getSettingValue = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/settings", () => ({ getSettingValue }));

const evaluateTrialAbuse = vi.hoisted(() => vi.fn());
const recordTrialClaim = vi.hoisted(() => vi.fn());
vi.mock("@/lib/trial-abuse", () => ({
  evaluateTrialAbuse,
  recordTrialClaim,
  getClientIp: () => "1.2.3.4",
  hashIp: () => "iphash",
}));

const findPriorTrial = vi.hoisted(() => vi.fn());
vi.mock("@/lib/trials/trial-history", async (orig) => ({
  ...(await orig<typeof import("@/lib/trials/trial-history")>()),
  findPriorTrial,
}));

// Inline DA provisioning is best-effort; keep it out of the unit test.
vi.mock("@/models/Hosting", () => ({ default: { findById: vi.fn().mockResolvedValue(null) } }));
vi.mock("@/lib/services/payment/tokens-da-provisioner", () => ({ provisionTokensFlowHosting: vi.fn() }));

vi.mock("@/lib/server-logger", () => ({ serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<typeof import("next/server")>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/user/hosting/start-trial/route";

const USER = { id: "U1", _id: "U1", email: "a@example.test", firstName: "Asha", lastName: "Rao", phone: "9876543210" };
const TRIAL = {
  domainName: "hosting-trial-starter-1",
  price: 0,
  currency: "INR",
  registrationPeriod: 15,
  periodUnit: "days",
  itemType: "hosting",
  billingCycle: "monthly",
  isTrial: true,
  linkedDomain: "rao.in",
  hostingPlan: { id: "starter", name: "Starter Hosting" },
};
const req = (cartItems: unknown[]) =>
  new NextRequest("https://dms.example.test/api/user/hosting/start-trial", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cartItems, deviceFingerprint: "fp" }),
  });

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(USER);
  createOrder.mockReset().mockResolvedValue({});
  userHasPriorTrialOrder.mockReset().mockResolvedValue(false);
  createManualFlowTrialHosting.mockReset().mockResolvedValue({ hostingId: "H1" });
  getPlanByPlanId.mockReset().mockResolvedValue({ planId: "Starter", name: "Starter", directAdminPackage: "Starter" });
  getSettingValue.mockReset().mockResolvedValue(true);
  evaluateTrialAbuse.mockReset().mockResolvedValue({ allowed: true });
  recordTrialClaim.mockReset().mockResolvedValue(undefined);
  findPriorTrial.mockReset().mockResolvedValue({ found: false });
});

describe("POST /api/user/hosting/start-trial", () => {
  it("signed out → 401", async () => {
    getUserFromRequest.mockResolvedValue(null);
    expect((await POST(req([TRIAL]))).status).toBe(401);
  });

  it("starts the trial: ₹0 hosting_trial Order + manual trial Hosting on the trial's cycle", async () => {
    const res = await POST(req([TRIAL]));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, manualMode: true, amount: 0 });
    expect(createOrder.mock.calls[0][0]).toMatchObject({ amount: 0, orderType: "hosting_trial", status: "pending", mandateMode: "manual" });
    expect(createManualFlowTrialHosting).toHaveBeenCalledWith(expect.objectContaining({ domainName: "rao.in", billingCycle: "monthly" }));
    expect(recordTrialClaim).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a paid line with the trial", [TRIAL, { ...TRIAL, isTrial: false, price: 118 }], /with other items/],
    ["a paid-only cart", [{ ...TRIAL, isTrial: false, price: 708 }], /with other items/],
    ["no domain", [{ ...TRIAL, linkedDomain: undefined }], /domain/i],
    ["a non-Starter plan", [{ ...TRIAL, hostingPlan: { id: "plus", name: "Plus" } }], /Starter/],
    ["no cycle", [{ ...TRIAL, billingCycle: undefined }], /billing cycle/],
  ])("refuses %s, and creates nothing", async (_label, items, pattern) => {
    const res = await POST(req(items as unknown[]));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(pattern);
    expect(createOrder).not.toHaveBeenCalled();
    expect(recordTrialClaim).not.toHaveBeenCalled();
  });

  it("trials switched off → refused", async () => {
    getSettingValue.mockResolvedValue(false);
    expect((await POST(req([TRIAL]))).status).toBe(400);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("a prior trial on this account → refused", async () => {
    userHasPriorTrialOrder.mockResolvedValue(true);
    expect((await POST(req([TRIAL]))).status).toBe(400);
  });

  it("a prior trial in EITHER app → refused; unreadable history → 503, nothing started", async () => {
    findPriorTrial.mockResolvedValueOnce({ found: true, via: "email", source: "reselleros" });
    expect((await POST(req([TRIAL]))).status).toBe(400);
    findPriorTrial.mockRejectedValueOnce(new Error("db down"));
    const res = await POST(req([TRIAL]));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/Nothing was charged/);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("the abuse checks refuse before any claim is recorded", async () => {
    evaluateTrialAbuse.mockResolvedValue({ allowed: false, reason: "Too many trials from this device", code: "DEVICE" });
    const res = await POST(req([TRIAL]));
    expect(res.status).toBe(400);
    expect(recordTrialClaim).not.toHaveBeenCalled();
  });

  it("makes no Razorpay call (source scan, comments stripped)", () => {
    const code = readFileSync(path.join(process.cwd(), "app/api/user/hosting/start-trial/route.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/@\/lib\/razorpay|RazorpayService|razorpay\.orders|createSubscription/);
  });
});
