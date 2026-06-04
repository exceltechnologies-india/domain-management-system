/**
 * Tests for `app/api/admin/hosting/packages/route.ts` (rescan-4 slice
 * 7g8). Three handlers: GET (list DA + DB), POST (create both),
 * PATCH (update + rotate Razorpay plans on renewal-price change).
 *
 * GET pins:
 *  - Admin gate → 403 FORBIDDEN
 *  - 5s DA timeout via Promise.race
 *  - DA failure → fallback DB-only (HostingPlan.find({isActive:true}))
 *  - New DA package not in DB → HostingPlan.create with config
 *    match by serverPackage OR raw package name; price from config
 *    or 0
 *  - Existing DB plan + DA fetch: update quota/bandwidth/details;
 *    'unlimited' → -1 (sentinel value); other strings → parseInt or 0
 *  - **Price-recovery when DB plan.price === 0**: re-look-up config
 *    and use config.price (handles legacy rows created before pricing
 *    was wired in)
 *  - Per-package getPackageDetails failure SWALLOWED (continues with
 *    empty details, other packages still processed)
 *  - Outer catch: tries DB fallback before 500
 *
 * POST pins:
 *  - Admin gate → 403
 *  - Schema: packageName min 1 max 100; quota/bandwidth union
 *    string|number; passthrough for arbitrary DA flags
 *  - createPackage signature: (packageName, {quota:str, bandwidth:str,
 *    ...otherOptions})
 *  - quota/bandwidth coerced to string for DA (DA accepts both shapes
 *    but coercion at boundary keeps the call signature narrow)
 *  - HostingPlan.create: planId=packageName, name=packageName,
 *    currency='INR', description default "", features default [],
 *    price default 0
 *  - 500 'PACKAGE_CREATION_FAILED' on any throw
 *
 * PATCH pins:
 *  - Admin gate → 403
 *  - Schema: id ObjectId required; name max 200; description max 2000;
 *    price/renewalPrice non-negative
 *  - findById null → 404 NOT_FOUND
 *  - Each field updated ONLY when defined (anti-overwrite-with-undefined)
 *  - **renewalPrice changed OR razorpayPlans missing** → rotate
 *    Razorpay plans (createPlan called twice: monthly + yearly)
 *  - Monthly plan: createPlan(`${plan.name} - Monthly`, ...,
 *    plan.renewalPrice, 'monthly')
 *  - **Yearly plan: createPlan with plan.renewalPrice × 12** (matches
 *    current pricing logic — no yearly discount applied)
 *  - razorpayPlans = {monthly: monthlyPlan.id, yearly: yearlyPlan.id}
 *  - Razorpay failure SWALLOWED — plan still saved locally
 *  - plan.save() ALWAYS called
 *  - 500 'UPDATE_FAILED' on outer catch
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const isAdmin = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  AuthService: { isAdmin },
}));

const daListPackages = vi.hoisted(() => vi.fn());
const daGetPackageDetails = vi.hoisted(() => vi.fn());
const daCreatePackage = vi.hoisted(() => vi.fn());
vi.mock("@/lib/directadmin", () => ({
  DirectAdminService: {
    listPackages: daListPackages,
    getPackageDetails: daGetPackageDetails,
    createPackage: daCreatePackage,
  },
}));

const HostingPlanFindOne = vi.hoisted(() => vi.fn());
const HostingPlanFindById = vi.hoisted(() => vi.fn());
const HostingPlanFind = vi.hoisted(() => vi.fn());
const HostingPlanCreate = vi.hoisted(() => vi.fn());
vi.mock("@/models/HostingPlan", () => ({
  default: {
    findOne: HostingPlanFindOne,
    findById: HostingPlanFindById,
    find: HostingPlanFind,
    create: HostingPlanCreate,
  },
}));

const connectToDatabase = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mongoose", () => ({ connectToDatabase }));

vi.mock("@/config/hosting-plans", () => ({
  HOSTING_PLANS: {
    starter: {
      id: "starter",
      name: "Starter",
      serverPackage: "Starter",
      price: 1500,
    },
    pro: {
      id: "pro",
      name: "Pro",
      serverPackage: "Pro",
      price: 5000,
    },
  },
}));

const razorpayCreatePlan = vi.hoisted(() => vi.fn());
vi.mock("@/lib/razorpay", () => ({
  RazorpayService: { createPlan: razorpayCreatePlan },
}));

const secureJsonResponse = vi.hoisted(() =>
  vi.fn((data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  )
);
const secureErrorResponse = vi.hoisted(() =>
  vi.fn((message: string, status: number, code: string) =>
    new Response(JSON.stringify({ error: message, code }), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  )
);
vi.mock("@/lib/api-response-wrapper", () => ({
  secureJsonResponse,
  secureErrorResponse,
}));

vi.mock("@/lib/server-logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.unmock("next/server");
const { NextRequest, NextResponse } = await vi.importActual<
  typeof import("next/server")
>("next/server");
vi.doMock("next/server", () => ({ NextRequest, NextResponse }));

import { GET, POST, PATCH } from "@/app/api/admin/hosting/packages/route";

function makeReq(method: "GET" | "POST" | "PATCH", body?: unknown) {
  return new NextRequest("https://example.com/api/admin/hosting/packages", {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function makePlan(overrides: Partial<any> = {}): any {
  return {
    _id: "P1",
    planId: "Starter",
    name: "Starter",
    description: "",
    price: 1500,
    renewalPrice: 1500,
    currency: "INR",
    features: [],
    directAdminPackage: "Starter",
    quota: 1024,
    bandwidth: 10240,
    isActive: true,
    razorpayPlans: { monthly: "plan_M", yearly: "plan_Y" },
    save: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  isAdmin.mockReset().mockResolvedValue(true);
  daListPackages.mockReset();
  daGetPackageDetails.mockReset();
  daCreatePackage.mockReset();
  HostingPlanFindOne.mockReset();
  HostingPlanFindById.mockReset();
  HostingPlanFind.mockReset();
  HostingPlanCreate.mockReset();
  connectToDatabase.mockReset().mockResolvedValue(undefined);
  razorpayCreatePlan.mockReset();
});

// ─── GET — admin gate ──────────────────────────────────────────────
describe("GET — admin gate", () => {
  it("not admin → 403 FORBIDDEN", async () => {
    isAdmin.mockResolvedValueOnce(false);
    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(403);
    expect(daListPackages).not.toHaveBeenCalled();
  });
});

// ─── GET — LIVE mode happy path ────────────────────────────────────
describe("GET — LIVE mode (DA available)", () => {
  it("new DA package not in DB → HostingPlan.create with config-matched id+name+price", async () => {
    daListPackages.mockResolvedValueOnce(["Starter"]);
    daGetPackageDetails.mockResolvedValueOnce({
      quota: "1024",
      bandwidth: "10240",
    });
    HostingPlanFindOne.mockResolvedValueOnce(null); // not in DB
    const newPlan = makePlan({ planId: "starter", name: "Starter", price: 1500 });
    HostingPlanCreate.mockResolvedValueOnce(newPlan);

    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(200);
    expect(HostingPlanCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: "starter", // from config
        name: "Starter",   // from config
        price: 1500,       // from config
        directAdminPackage: "Starter",
        quota: 1024,
        bandwidth: 10240,
        isActive: true,
      })
    );
  });

  it("new DA package with NO config match → uses raw package name + price 0", async () => {
    daListPackages.mockResolvedValueOnce(["UnknownPkg"]);
    daGetPackageDetails.mockResolvedValueOnce({});
    HostingPlanFindOne.mockResolvedValueOnce(null);
    HostingPlanCreate.mockResolvedValueOnce(makePlan());

    await GET(makeReq("GET"));
    expect(HostingPlanCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: "UnknownPkg",
        name: "UnknownPkg",
        price: 0,
      })
    );
  });

  it("'unlimited' quota/bandwidth → -1 sentinel", async () => {
    daListPackages.mockResolvedValueOnce(["Pro"]);
    daGetPackageDetails.mockResolvedValueOnce({
      quota: "unlimited",
      bandwidth: "Unlimited", // case-insensitive
    });
    HostingPlanFindOne.mockResolvedValueOnce(null);
    HostingPlanCreate.mockResolvedValueOnce(makePlan());

    await GET(makeReq("GET"));
    expect(HostingPlanCreate).toHaveBeenCalledWith(
      expect.objectContaining({ quota: -1, bandwidth: -1 })
    );
  });

  it("existing DB plan: updates quota/bandwidth/details; preserves price > 0", async () => {
    daListPackages.mockResolvedValueOnce(["Starter"]);
    daGetPackageDetails.mockResolvedValueOnce({
      quota: "2048",
      bandwidth: "20480",
    });
    const existing = makePlan({ price: 1500 });
    HostingPlanFindOne.mockResolvedValueOnce(existing);

    await GET(makeReq("GET"));

    expect(existing.quota).toBe(2048);
    expect(existing.bandwidth).toBe(20480);
    expect(existing.price).toBe(1500); // unchanged
    expect(existing.save).toHaveBeenCalled();
    expect(HostingPlanCreate).not.toHaveBeenCalled();
  });

  it("**Price-recovery when DB plan.price === 0**: re-look-up config and set config.price", async () => {
    daListPackages.mockResolvedValueOnce(["Starter"]);
    daGetPackageDetails.mockResolvedValueOnce({
      quota: "1024",
      bandwidth: "10240",
    });
    const existing = makePlan({ price: 0 }); // legacy row with no price
    HostingPlanFindOne.mockResolvedValueOnce(existing);

    await GET(makeReq("GET"));

    expect(existing.price).toBe(1500); // recovered from config
  });

  it("price=0 + no config match → stays 0 (no override)", async () => {
    daListPackages.mockResolvedValueOnce(["Mystery"]);
    daGetPackageDetails.mockResolvedValueOnce({ quota: "1024" });
    const existing = makePlan({
      planId: "Mystery",
      directAdminPackage: "Mystery",
      price: 0,
    });
    HostingPlanFindOne.mockResolvedValueOnce(existing);

    await GET(makeReq("GET"));
    expect(existing.price).toBe(0); // no recovery possible
  });

  it("per-package getPackageDetails failure SWALLOWED (other packages still processed)", async () => {
    daListPackages.mockResolvedValueOnce(["Broken", "Starter"]);
    daGetPackageDetails
      .mockRejectedValueOnce(new Error("DA per-package failed"))
      .mockResolvedValueOnce({ quota: "1024" });
    HostingPlanFindOne
      .mockResolvedValueOnce(null) // for Broken
      .mockResolvedValueOnce(null); // for Starter
    HostingPlanCreate
      .mockResolvedValueOnce(makePlan({ planId: "Broken" }))
      .mockResolvedValueOnce(makePlan({ planId: "starter" }));

    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(200);
    expect(HostingPlanCreate).toHaveBeenCalledTimes(2); // both processed
  });

  it("response shape: success + data + source:'live' + warning:null", async () => {
    daListPackages.mockResolvedValueOnce([]);
    const res = await GET(makeReq("GET"));
    const body = await res.json();
    expect(body).toMatchObject({
      success: true,
      data: [],
      source: "live",
      warning: null,
    });
  });
});

// ─── GET — DA-unreachable fallback ────────────────────────────────
describe("GET — DA unreachable → DB-only fallback", () => {
  it("DA list throw → HostingPlan.find({isActive:true}); source:'db'; warning set", async () => {
    daListPackages.mockRejectedValueOnce(new Error("DA down"));
    HostingPlanFind.mockResolvedValueOnce([
      makePlan({ planId: "Starter" }),
      makePlan({ planId: "Pro" }),
    ]);

    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(200);
    expect(HostingPlanFind).toHaveBeenCalledWith({ isActive: true });
    const body = await res.json();
    expect(body.source).toBe("db");
    expect(body.warning).toMatch(/DirectAdmin unreachable/);
    expect(body.data).toHaveLength(2);
  });
});

// ─── GET — 5-second DA timeout ─────────────────────────────────────
describe("GET — 5s DA timeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("DA hang past 5s → fallback DB mode (timer fires DA_TIMEOUT)", async () => {
    daListPackages.mockImplementationOnce(() => new Promise(() => {}));
    HostingPlanFind.mockResolvedValueOnce([]);

    const pending = GET(makeReq("GET"));
    await vi.advanceTimersByTimeAsync(5001);
    const res = await pending;

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("db");
  });
});

// ─── GET — outer catch fallback ────────────────────────────────────
describe("GET — outer catch fallback", () => {
  it("connectToDatabase throw → tries DB fallback once more", async () => {
    connectToDatabase.mockRejectedValueOnce(new Error("DB down"));
    HostingPlanFind.mockResolvedValueOnce([
      makePlan({ planId: "Starter" }),
    ]);

    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("db");
    expect(body.warning).toMatch(/System error/);
  });

  it("DB fallback ALSO fails → 500 PACKAGES_FETCH_FAILED", async () => {
    connectToDatabase.mockRejectedValueOnce(new Error("DB down"));
    HostingPlanFind.mockRejectedValueOnce(new Error("DB also down"));

    const res = await GET(makeReq("GET"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("PACKAGES_FETCH_FAILED");
  });
});

// ─── POST — admin gate + schema ────────────────────────────────────
describe("POST — admin gate + schema", () => {
  it("not admin → 403 FORBIDDEN (no DA call, no DB)", async () => {
    isAdmin.mockResolvedValueOnce(false);
    const res = await POST(makeReq("POST", { packageName: "X" }));
    expect(res.status).toBe(403);
    expect(daCreatePackage).not.toHaveBeenCalled();
    expect(HostingPlanCreate).not.toHaveBeenCalled();
  });

  it("missing packageName → schema rejection", async () => {
    const res = await POST(makeReq("POST", {}));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("negative price → schema rejection", async () => {
    const res = await POST(
      makeReq("POST", { packageName: "X", price: -1 })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("packageName > 100 chars → schema rejection", async () => {
    const res = await POST(
      makeReq("POST", { packageName: "x".repeat(101) })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

// ─── POST — create flow ────────────────────────────────────────────
describe("POST — create flow", () => {
  it("DA createPackage called with (packageName, {quota:str, bandwidth:str, ...otherOptions}) — both coerced to string", async () => {
    HostingPlanCreate.mockResolvedValueOnce(makePlan());
    await POST(
      makeReq("POST", {
        packageName: "Custom",
        quota: 5120, // number
        bandwidth: "10240", // string
        php: "8.2", // arbitrary DA option (passthrough)
      })
    );

    expect(daCreatePackage).toHaveBeenCalledWith("Custom", {
      quota: "5120",
      bandwidth: "10240",
      php: "8.2",
    });
  });

  it("HostingPlan.create with planId=name=packageName, currency='INR', defaults applied", async () => {
    HostingPlanCreate.mockResolvedValueOnce(makePlan());
    await POST(makeReq("POST", { packageName: "Custom" }));

    expect(HostingPlanCreate).toHaveBeenCalledWith({
      planId: "Custom",
      name: "Custom",
      description: "",
      price: 0,
      currency: "INR",
      features: [],
      directAdminPackage: "Custom",
      quota: 0,
      bandwidth: 0,
      isActive: true,
    });
  });

  it("description + features + price flow through; quota/bandwidth parsed as ints", async () => {
    HostingPlanCreate.mockResolvedValueOnce(makePlan());
    await POST(
      makeReq("POST", {
        packageName: "Big",
        description: "Big package",
        features: ["SSL", "DDOS"],
        price: 2999,
        quota: "5120",
        bandwidth: 20480,
      })
    );

    const payload = HostingPlanCreate.mock.calls[0][0];
    expect(payload.description).toBe("Big package");
    expect(payload.features).toEqual(["SSL", "DDOS"]);
    expect(payload.price).toBe(2999);
    expect(payload.quota).toBe(5120);
    expect(payload.bandwidth).toBe(20480);
  });

  it("DA createPackage throw → 500 PACKAGE_CREATION_FAILED (DB skipped)", async () => {
    daCreatePackage.mockRejectedValueOnce(new Error("DA package exists"));
    const res = await POST(makeReq("POST", { packageName: "Dup" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("PACKAGE_CREATION_FAILED");
    expect(HostingPlanCreate).not.toHaveBeenCalled();
  });

  it("Response shape: success + message + data (new plan)", async () => {
    const newPlan = makePlan({ planId: "Custom" });
    HostingPlanCreate.mockResolvedValueOnce(newPlan);
    const res = await POST(makeReq("POST", { packageName: "Custom" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toBe("Package 'Custom' created successfully.");
    expect(body.data.planId).toBe("Custom");
  });
});

// ─── PATCH — admin gate + schema ───────────────────────────────────
describe("PATCH — admin gate + schema", () => {
  it("not admin → 403", async () => {
    isAdmin.mockResolvedValueOnce(false);
    const res = await PATCH(
      makeReq("PATCH", { id: "507f1f77bcf86cd799439011", name: "X" })
    );
    expect(res.status).toBe(403);
  });

  it("missing id → schema rejection", async () => {
    const res = await PATCH(makeReq("PATCH", { name: "X" }));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("invalid id format → schema rejection", async () => {
    const res = await PATCH(
      makeReq("PATCH", { id: "not-a-objectid", name: "X" })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("name > 200 chars → rejection", async () => {
    const res = await PATCH(
      makeReq("PATCH", {
        id: "507f1f77bcf86cd799439011",
        name: "x".repeat(201),
      })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("description > 2000 chars → rejection", async () => {
    const res = await PATCH(
      makeReq("PATCH", {
        id: "507f1f77bcf86cd799439011",
        description: "x".repeat(2001),
      })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("negative renewalPrice → rejection", async () => {
    const res = await PATCH(
      makeReq("PATCH", {
        id: "507f1f77bcf86cd799439011",
        renewalPrice: -1,
      })
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("PATCH — not found", () => {
  it("findById null → 404 NOT_FOUND", async () => {
    HostingPlanFindById.mockResolvedValueOnce(null);
    const res = await PATCH(
      makeReq("PATCH", {
        id: "507f1f77bcf86cd799439011",
        name: "New Name",
      })
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });
});

// ─── PATCH — field updates ─────────────────────────────────────────
describe("PATCH — field updates (anti-overwrite-with-undefined)", () => {
  it("each field updated ONLY when defined; absent fields preserved", async () => {
    const plan = makePlan({
      name: "Old",
      description: "Old desc",
      price: 1000,
      features: ["old"],
      isActive: true,
    });
    HostingPlanFindById.mockResolvedValueOnce(plan);

    await PATCH(
      makeReq("PATCH", {
        id: "507f1f77bcf86cd799439011",
        name: "New",
      })
    );

    expect(plan.name).toBe("New");
    expect(plan.description).toBe("Old desc"); // unchanged
    expect(plan.price).toBe(1000); // unchanged
    expect(plan.features).toEqual(["old"]); // unchanged
    expect(plan.isActive).toBe(true); // unchanged
    expect(plan.save).toHaveBeenCalled();
  });

  it("isActive=false update applied (the only safe falsy update)", async () => {
    const plan = makePlan({ isActive: true });
    HostingPlanFindById.mockResolvedValueOnce(plan);

    await PATCH(
      makeReq("PATCH", {
        id: "507f1f77bcf86cd799439011",
        isActive: false,
      })
    );

    expect(plan.isActive).toBe(false);
  });
});

// ─── PATCH — Razorpay plan rotation ───────────────────────────────
describe("PATCH — Razorpay rotation", () => {
  it("renewalPrice CHANGED → createPlan called twice (monthly + yearly)", async () => {
    const plan = makePlan({
      name: "Pro",
      renewalPrice: 1000,
      razorpayPlans: { monthly: "M1", yearly: "Y1" },
    });
    HostingPlanFindById.mockResolvedValueOnce(plan);
    razorpayCreatePlan
      .mockResolvedValueOnce({ id: "plan_M_NEW" })
      .mockResolvedValueOnce({ id: "plan_Y_NEW" });

    await PATCH(
      makeReq("PATCH", {
        id: "507f1f77bcf86cd799439011",
        renewalPrice: 2000,
      })
    );

    expect(razorpayCreatePlan).toHaveBeenCalledTimes(2);
    // Monthly: (name+' - Monthly', desc, newRenewalPrice, 'monthly')
    expect(razorpayCreatePlan).toHaveBeenNthCalledWith(
      1,
      "Pro - Monthly",
      "Renewal for Pro",
      2000,
      "monthly"
    );
    // Yearly: (name+' - Yearly', desc, newRenewalPrice * 12, 'yearly')
    expect(razorpayCreatePlan).toHaveBeenNthCalledWith(
      2,
      "Pro - Yearly",
      "Annual Renewal for Pro",
      24000, // 2000 × 12
      "yearly"
    );
  });

  it("razorpayPlans IDs rotated to new ones in plan.razorpayPlans", async () => {
    const plan = makePlan({
      renewalPrice: 1000,
      razorpayPlans: { monthly: "M_old", yearly: "Y_old" },
    });
    HostingPlanFindById.mockResolvedValueOnce(plan);
    razorpayCreatePlan
      .mockResolvedValueOnce({ id: "M_new" })
      .mockResolvedValueOnce({ id: "Y_new" });

    await PATCH(
      makeReq("PATCH", {
        id: "507f1f77bcf86cd799439011",
        renewalPrice: 2000,
      })
    );

    expect(plan.razorpayPlans.monthly).toBe("M_new");
    expect(plan.razorpayPlans.yearly).toBe("Y_new");
  });

  it("renewalPrice UNCHANGED + razorpayPlans present → NO rotation", async () => {
    const plan = makePlan({
      renewalPrice: 1500,
      razorpayPlans: { monthly: "M", yearly: "Y" },
    });
    HostingPlanFindById.mockResolvedValueOnce(plan);

    await PATCH(
      makeReq("PATCH", {
        id: "507f1f77bcf86cd799439011",
        renewalPrice: 1500, // same as existing
      })
    );

    expect(razorpayCreatePlan).not.toHaveBeenCalled();
  });

  it("renewalPrice UNCHANGED but razorpayPlans MISSING → rotation fires", async () => {
    const plan = makePlan({
      renewalPrice: 1500,
      razorpayPlans: undefined,
    });
    HostingPlanFindById.mockResolvedValueOnce(plan);
    razorpayCreatePlan
      .mockResolvedValueOnce({ id: "M_first" })
      .mockResolvedValueOnce({ id: "Y_first" });

    // No renewalPrice in body — but plan has no razorpayPlans yet
    await PATCH(
      makeReq("PATCH", {
        id: "507f1f77bcf86cd799439011",
        name: "Different Name",
      })
    );

    expect(razorpayCreatePlan).toHaveBeenCalledTimes(2);
  });

  it("renewalPrice UNCHANGED + only monthly missing → rotation fires", async () => {
    const plan = makePlan({
      renewalPrice: 1500,
      razorpayPlans: { yearly: "Y_only" } as any, // monthly missing
    });
    HostingPlanFindById.mockResolvedValueOnce(plan);
    razorpayCreatePlan
      .mockResolvedValueOnce({ id: "M_new" })
      .mockResolvedValueOnce({ id: "Y_new" });

    await PATCH(
      makeReq("PATCH", {
        id: "507f1f77bcf86cd799439011",
        name: "Rename",
      })
    );

    expect(razorpayCreatePlan).toHaveBeenCalledTimes(2);
  });

  it("**Razorpay failure SWALLOWED** — plan still saved locally", async () => {
    const plan = makePlan({
      renewalPrice: 1000,
      razorpayPlans: { monthly: "M_OLD", yearly: "Y_OLD" },
    });
    HostingPlanFindById.mockResolvedValueOnce(plan);
    razorpayCreatePlan.mockRejectedValueOnce(new Error("Razorpay down"));

    const res = await PATCH(
      makeReq("PATCH", {
        id: "507f1f77bcf86cd799439011",
        renewalPrice: 2000,
        name: "Updated Name",
      })
    );

    expect(res.status).toBe(200);
    expect(plan.renewalPrice).toBe(2000); // local update applied
    expect(plan.name).toBe("Updated Name");
    expect(plan.razorpayPlans.monthly).toBe("M_OLD"); // unchanged
    expect(plan.save).toHaveBeenCalled();
  });
});

// ─── PATCH — happy response + outer catch ──────────────────────────
describe("PATCH — happy response + outer catch", () => {
  it("happy response: success + message + data", async () => {
    HostingPlanFindById.mockResolvedValueOnce(makePlan());

    const res = await PATCH(
      makeReq("PATCH", {
        id: "507f1f77bcf86cd799439011",
        name: "Updated",
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toBe("Hosting package updated successfully.");
  });

  it("findById throw → 500 UPDATE_FAILED", async () => {
    HostingPlanFindById.mockRejectedValueOnce(new Error("DB down"));
    const res = await PATCH(
      makeReq("PATCH", {
        id: "507f1f77bcf86cd799439011",
        name: "X",
      })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("UPDATE_FAILED");
  });

  it("plan.save throw → 500 UPDATE_FAILED", async () => {
    const plan = makePlan({
      save: vi.fn().mockRejectedValueOnce(new Error("DB write down")),
    });
    HostingPlanFindById.mockResolvedValueOnce(plan);
    const res = await PATCH(
      makeReq("PATCH", {
        id: "507f1f77bcf86cd799439011",
        name: "X",
      })
    );
    expect(res.status).toBe(500);
  });
});
