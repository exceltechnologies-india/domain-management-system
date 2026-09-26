/**
 * Tests for `app/api/user/hosting/trial-eligibility/route.ts` — the panel's
 * free-trial PRE-check.
 *
 * Since 26 Sep 2026 (owner: "Ask ResellerOS instead") ResellerOS decides
 * whether this customer has had a trial (lib/reselleros/trial-eligibility.ts),
 * the same check its startHostingTrial runs, so the button and the checkout
 * cannot disagree. Pinned:
 *  - Auth → 401; the trials switch; the abuse checks; Starter only; the plan
 *    must exist — the layers DMS keeps
 *  - identity sent to ResellerOS is the SESSION's (email, phone), never the
 *    body's; a domain only when it is a real name
 *  - ResellerOS's "not eligible" reason is shown as written
 *  - FAIL CLOSED: ResellerOS unable to answer → eligible:false with the
 *    "can't check right now" message — never eligible, never DMS's own answer
 *  - source scan: the route no longer decides with DMS's own trial history
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const getUserFromRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ AuthService: { getUserFromRequest } }));

const checkTrialEligibility = vi.hoisted(() => vi.fn());
vi.mock("@/lib/reselleros/trial-eligibility", async (orig) => ({
  ...(await orig<typeof import("@/lib/reselleros/trial-eligibility")>()),
  checkTrialEligibility,
}));

const getPlanByPlanId = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/hosting-plans", () => ({ getPlanByPlanId }));

const getSettingValue = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/settings", () => ({ getSettingValue }));

const evaluateTrialAbuse = vi.hoisted(() => vi.fn());
vi.mock("@/lib/trial-abuse", () => ({
  evaluateTrialAbuse,
  getClientIp: () => "203.0.113.1",
  hashIp: () => "hashed_ip",
}));

vi.mock("@/lib/server-logger", () => ({ serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<typeof import("next/server")>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET, POST } from "@/app/api/user/hosting/trial-eligibility/route";
import { CANNOT_CHECK_TRIAL_MESSAGE } from "@/lib/reselleros/trial-eligibility";

const makeGet = (qs = "") =>
  new NextRequest(`https://example.com/api/user/hosting/trial-eligibility${qs ? `?${qs}` : ""}`, { method: "GET" });
const makePost = (body: unknown = {}) =>
  new NextRequest("https://example.com/api/user/hosting/trial-eligibility", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const USER = { _id: "U1", email: "alice@example.com", phone: "9999999999" };

beforeEach(() => {
  getUserFromRequest.mockReset().mockResolvedValue(USER);
  checkTrialEligibility.mockReset().mockResolvedValue({ kind: "eligible" });
  getPlanByPlanId.mockReset().mockResolvedValue({ planId: "Starter", name: "Starter" });
  getSettingValue.mockReset().mockResolvedValue(true);
  evaluateTrialAbuse.mockReset().mockResolvedValue({ allowed: true });
});

describe("Auth gate", () => {
  it("POST: no user → 401; ResellerOS not asked", async () => {
    getUserFromRequest.mockResolvedValue(null);
    expect((await POST(makePost())).status).toBe(401);
    expect(checkTrialEligibility).not.toHaveBeenCalled();
  });

  it("GET: no user → 401", async () => {
    getUserFromRequest.mockResolvedValue(null);
    expect((await GET(makeGet())).status).toBe(401);
  });
});

describe("DMS's trials switch", () => {
  it("hosting_trial_enabled === false → eligible:false; ResellerOS not asked", async () => {
    getSettingValue.mockResolvedValue(false);
    const body = await (await POST(makePost())).json();
    expect(body).toMatchObject({ eligible: false, reason: "Trials are currently unavailable" });
    expect(checkTrialEligibility).not.toHaveBeenCalled();
  });
});

describe("ResellerOS decides the one-trial rule", () => {
  it("asks with the SESSION's email and phone, not the body's", async () => {
    await POST(makePost({ email: "mallory@example.com", phone: "1111111111" }));
    expect(checkTrialEligibility).toHaveBeenCalledWith({ email: "alice@example.com", phone: "9999999999" });
  });

  it("sends the domain only when it is a real name", async () => {
    await POST(makePost({ domain: "Rao.IN" }));
    expect(checkTrialEligibility.mock.calls[0][0]).toMatchObject({ domain: "rao.in" });
    checkTrialEligibility.mockClear();
    await POST(makePost({ domain: "hosting-trial-starter-1" }));
    expect(checkTrialEligibility.mock.calls[0][0]).not.toHaveProperty("domain");
  });

  it("not eligible → ResellerOS's reason, as written", async () => {
    checkTrialEligibility.mockResolvedValue({ kind: "not_eligible", reason: "You had a free trial on 1 Aug with rao.in." });
    const body = await (await POST(makePost())).json();
    expect(body).toEqual({ eligible: false, reason: "You had a free trial on 1 Aug with rao.in." });
  });

  it("FAIL CLOSED: ResellerOS cannot answer → 'can't check right now', never eligible", async () => {
    checkTrialEligibility.mockResolvedValue({ kind: "cannot_check", detail: "HTTP 503: history unreadable" });
    const res = await POST(makePost({ planId: "starter" }));
    const body = await res.json();
    expect(body.eligible).toBe(false);
    expect(body.reason).toBe(CANNOT_CHECK_TRIAL_MESSAGE);
    expect(body.code).toBe("CANNOT_CHECK");
    // It stops here: no later layer can turn it into a yes.
    expect(evaluateTrialAbuse).not.toHaveBeenCalled();
  });
});

describe("the layers DMS keeps", () => {
  it("abuse check refuses → eligible:false with the helper's code + reason", async () => {
    evaluateTrialAbuse.mockResolvedValue({ allowed: false, reason: "Too many trials from this device", code: "DEVICE" });
    const body = await (await POST(makePost({ deviceFingerprint: "fp" }))).json();
    expect(body).toEqual({ eligible: false, reason: "Too many trials from this device", code: "DEVICE" });
    expect(evaluateTrialAbuse.mock.calls[0][0]).toMatchObject({ email: "alice@example.com", deviceFingerprint: "fp" });
  });

  it("a non-Starter plan → refused", async () => {
    const body = await (await POST(makePost({ planId: "plus" }))).json();
    expect(body.eligible).toBe(false);
  });

  it("the plan missing → refused", async () => {
    getPlanByPlanId.mockResolvedValue(null);
    const body = await (await POST(makePost({ planId: "starter" }))).json();
    expect(body).toEqual({ eligible: false, reason: "This plan is not available for a free trial" });
  });

  it("no Razorpay plan is needed any more (the trial starts in ResellerOS)", async () => {
    getPlanByPlanId.mockResolvedValue({ planId: "Starter", name: "Starter", razorpayPlans: {} });
    const body = await (await POST(makePost({ planId: "starter" }))).json();
    expect(body).toEqual({ eligible: true, trialDays: 15 });
  });

  it("GET with ?planId runs the same checks", async () => {
    const body = await (await GET(makeGet("planId=plus"))).json();
    expect(body.eligible).toBe(false);
  });

  it("bogus planId type → 400", async () => {
    expect((await POST(makePost({ planId: 123 }))).status).toBe(400);
  });

  it("an unexpected throw → 500, never a yes", async () => {
    evaluateTrialAbuse.mockRejectedValue(new Error("redis down"));
    const res = await POST(makePost());
    expect(res.status).toBe(500);
  });
});

describe("source scan (comments stripped)", () => {
  it("the route no longer decides with DMS's own trial history", () => {
    const code = readFileSync(path.join(process.cwd(), "app/api/user/hosting/trial-eligibility/route.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/userHasPriorTrialOrder|findPriorTrial|trial-history|@\/lib\/services\/orders|ExternalTrial/);
    expect(code).toMatch(/checkTrialEligibility\(/);
  });
});
