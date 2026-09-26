/**
 * app/api/user/hosting/start-trial — since 26 Sep 2026 the panel trial is
 * STARTED IN RESELLEROS (owner: "Move it to ResellerOS").
 *
 * Pinned: the lone-trial / Starter / cycle / trials-switch / abuse gates stay
 * here; identity sent to ResellerOS is the session's; NOTHING is created in
 * DMS (no Order, no Hosting — source scan); the abuse claim is recorded only
 * after ResellerOS accepts; a 409 already-trialled is shown as written; a
 * timeout says it may have gone through and is sent once; ResellerOS refusing
 * our key is a 503, never a 401; success returns the confirm-your-email text.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ AuthService: { getUserFromRequest } }));

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

const startTrialInResellerOs = vi.hoisted(() => vi.fn());
vi.mock("@/lib/reselleros/start-trial", async (orig) => ({
  ...(await orig<typeof import("@/lib/reselleros/start-trial")>()),
  startTrialInResellerOs,
}));

vi.mock("@/lib/server-logger", () => ({ serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<typeof import("next/server")>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { POST } from "@/app/api/user/hosting/start-trial/route";

const USER = { _id: "U1", email: "a@example.test", firstName: "Asha", lastName: "Rao", phone: "98765 43210", companyName: "Rao Traders" };
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
const req = (cartItems: unknown[], extra: Record<string, unknown> = {}) =>
  new NextRequest("https://dms.example.test/api/user/hosting/start-trial", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cartItems, deviceFingerprint: "fp", ...extra }),
  });

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(USER);
  getSettingValue.mockReset().mockResolvedValue(true);
  evaluateTrialAbuse.mockReset().mockResolvedValue({ allowed: true });
  recordTrialClaim.mockReset().mockResolvedValue(undefined);
  startTrialInResellerOs.mockReset().mockResolvedValue({ kind: "ok", leadId: "L-9", trialEnds: "2026-10-11" });
});

describe("POST /api/user/hosting/start-trial", () => {
  it("signed out → 401, ResellerOS not asked", async () => {
    getUserFromRequest.mockResolvedValue(null);
    expect((await POST(req([TRIAL]))).status).toBe(401);
    expect(startTrialInResellerOs).not.toHaveBeenCalled();
  });

  it("starts the trial in ResellerOS with the SESSION's identity; says to confirm by email", async () => {
    const res = await POST(req([TRIAL], { email: "mallory@example.test" }));
    expect(res.status).toBe(200);
    expect(startTrialInResellerOs).toHaveBeenCalledWith({
      dmsUserId: "U1",
      fullName: "Asha Rao",
      companyName: "Rao Traders",
      email: "a@example.test",
      phone: "9876543210",
      domain: "rao.in",
      cycle: "monthly",
    });
    expect(await res.json()).toEqual({
      success: true,
      leadId: "L-9",
      trialEnds: "2026-10-11",
      message: "Check your email to confirm; your trial account is created once you confirm.",
    });
    expect(recordTrialClaim).toHaveBeenCalledTimes(1);
  });

  it("no real domain on the line → sent without one (ResellerOS allows it)", async () => {
    await POST(req([{ ...TRIAL, linkedDomain: undefined }]));
    expect(startTrialInResellerOs.mock.calls[0][0]).not.toHaveProperty("domain");
  });

  it.each([
    ["a paid line with the trial", [TRIAL, { ...TRIAL, isTrial: false, price: 118 }], /with other items/],
    ["a non-Starter plan", [{ ...TRIAL, hostingPlan: { id: "plus", name: "Plus" } }], /Starter/],
    ["no cycle", [{ ...TRIAL, billingCycle: undefined }], /billing cycle/],
  ])("refuses %s before ResellerOS is asked", async (_l, items, pattern) => {
    const res = await POST(req(items as unknown[]));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(pattern);
    expect(startTrialInResellerOs).not.toHaveBeenCalled();
  });

  it("no phone on the account → refused, pointing at Settings", async () => {
    getUserFromRequest.mockResolvedValue({ ...USER, phone: "" });
    const res = await POST(req([TRIAL]));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Settings/);
    expect(startTrialInResellerOs).not.toHaveBeenCalled();
  });

  it("trials switched off / the abuse checks refuse → nothing sent, no claim", async () => {
    getSettingValue.mockResolvedValueOnce(false);
    expect((await POST(req([TRIAL]))).status).toBe(400);
    evaluateTrialAbuse.mockResolvedValueOnce({ allowed: false, reason: "Too many trials from this device", code: "DEVICE" });
    const res = await POST(req([TRIAL]));
    expect((await res.json()).error).toBe("Too many trials from this device");
    expect(startTrialInResellerOs).not.toHaveBeenCalled();
    expect(recordTrialClaim).not.toHaveBeenCalled();
  });

  it("already trialled at ResellerOS → 409 with ResellerOS's words, no claim recorded", async () => {
    startTrialInResellerOs.mockResolvedValue({ kind: "already_trialled", message: "You had a trial on 1 Aug with rao.in." });
    const res = await POST(req([TRIAL]));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("You had a trial on 1 Aug with rao.in.");
    expect(recordTrialClaim).not.toHaveBeenCalled();
  });

  it("a timeout → 503, 'may have gone through, check your email', sent once", async () => {
    startTrialInResellerOs.mockResolvedValue({ kind: "unreachable", detail: "TimeoutError", mayHaveStarted: true });
    const res = await POST(req([TRIAL]));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.mayHaveStarted).toBe(true);
    expect(body.error).toMatch(/may have gone through/);
    expect(body.error).toMatch(/check your email/i);
    expect(startTrialInResellerOs).toHaveBeenCalledTimes(1);
  });

  it("ResellerOS refusing our key → 503, never 401", async () => {
    startTrialInResellerOs.mockResolvedValue({ kind: "config", status: 401, detail: "bad key" });
    expect((await POST(req([TRIAL]))).status).toBe(503);
  });

  it("a ResellerOS 500 message is shown as written", async () => {
    startTrialInResellerOs.mockResolvedValue({ kind: "failed", message: "Couldn't save the trial. Nothing was charged." });
    const res = await POST(req([TRIAL]));
    expect((await res.json()).error).toBe("Couldn't save the trial. Nothing was charged.");
  });

  it("creates nothing in DMS (source scan, comments stripped)", () => {
    const code = readFileSync(path.join(process.cwd(), "app/api/user/hosting/start-trial/route.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/createOrder|createManualFlowTrialHosting|createHosting|provisionTokensFlowHosting|@\/models\/|@\/lib\/razorpay/);
  });
});
