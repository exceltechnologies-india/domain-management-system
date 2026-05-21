/**
 * Service-layer integration tests for lib/services/hosting-plans.ts.
 *
 * Covers the read helpers (every renewal/upgrade/trial path starts here) +
 * the admin upsert / toggle writes.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { clearAllCollections } from "../setup";
import HostingPlan from "@/models/HostingPlan";
import {
  getPlanByPlanId,
  getPlanByPlanIdLean,
  getPlanById,
  getPlanByRazorpaySubscriptionPlanId,
  listActivePlans,
  setPlanActive,
  upsertPlanByPlanId,
} from "@/lib/services/hosting-plans";

function buildPlanPayload(overrides: Record<string, unknown> = {}) {
  const tag = Math.random().toString(36).slice(2, 8);
  return {
    planId: `plan_${tag}`,
    name: `Plan ${tag}`,
    price: 1000,
    currency: "INR",
    directAdminPackage: `DA_${tag}`,
    quota: 5,
    bandwidth: 50,
    isActive: true,
    ...overrides,
  };
}

beforeAll(async () => {
  expect(mongoose.connection.readyState).toBe(1);
  await HostingPlan.syncIndexes();
});

beforeEach(clearAllCollections);

describe("getPlanByPlanId", () => {
  it("returns the plan by external planId", async () => {
    await HostingPlan.create(buildPlanPayload({ planId: "starter" }));
    expect((await getPlanByPlanId("starter"))?.planId).toBe("starter");
  });

  it("respects activeOnly filter", async () => {
    await HostingPlan.create(buildPlanPayload({ planId: "inactive", isActive: false }));
    expect((await getPlanByPlanId("inactive"))?.planId).toBe("inactive");
    expect(await getPlanByPlanId("inactive", { activeOnly: true })).toBeNull();
  });

  it("returns null when not found", async () => {
    expect(await getPlanByPlanId("nope")).toBeNull();
  });
});

describe("getPlanById", () => {
  it("returns the plan by Mongo _id", async () => {
    const created = await HostingPlan.create(buildPlanPayload());
    expect((await getPlanById(String(created._id)))?._id.toString()).toBe(
      created._id.toString()
    );
  });
});

describe("getPlanByRazorpaySubscriptionPlanId", () => {
  it("matches either razorpayPlans.monthly or razorpayPlans.yearly", async () => {
    await HostingPlan.create(
      buildPlanPayload({
        planId: "with-rzp",
        razorpayPlans: { monthly: "rzp_m_abc", yearly: "rzp_y_def" },
      })
    );
    expect((await getPlanByRazorpaySubscriptionPlanId("rzp_m_abc"))?.planId).toBe(
      "with-rzp"
    );
    expect((await getPlanByRazorpaySubscriptionPlanId("rzp_y_def"))?.planId).toBe(
      "with-rzp"
    );
    expect(await getPlanByRazorpaySubscriptionPlanId("rzp_missing")).toBeNull();
  });
});

describe("listActivePlans", () => {
  it("returns active plans sorted by price ascending by default", async () => {
    await HostingPlan.create(buildPlanPayload({ planId: "plus", price: 3000 }));
    await HostingPlan.create(buildPlanPayload({ planId: "starter", price: 1000 }));
    await HostingPlan.create(buildPlanPayload({ planId: "standard", price: 2000 }));
    await HostingPlan.create(buildPlanPayload({ planId: "off", isActive: false, price: 500 }));

    const list = await listActivePlans();
    expect(list.map((p) => p.planId)).toEqual(["starter", "standard", "plus"]);
  });

  it("can sort price-desc", async () => {
    await HostingPlan.create(buildPlanPayload({ planId: "a", price: 100 }));
    await HostingPlan.create(buildPlanPayload({ planId: "b", price: 200 }));
    const list = await listActivePlans({ sort: "price-desc" });
    expect(list.map((p) => p.planId)).toEqual(["b", "a"]);
  });
});

describe("getPlanByPlanIdLean", () => {
  it("returns a lean (non-Mongoose-Document) object", async () => {
    await HostingPlan.create(buildPlanPayload({ planId: "lean" }));
    const lean = await getPlanByPlanIdLean("lean");
    expect(lean?.planId).toBe("lean");
    expect((lean as unknown as { save?: unknown })?.save).toBeUndefined();
  });
});

describe("setPlanActive", () => {
  it("returns matched=1 modified=1 when toggling an existing plan", async () => {
    await HostingPlan.create(buildPlanPayload({ planId: "toggle", isActive: true }));
    const r = await setPlanActive("toggle", false);
    expect(r.matched).toBe(1);
    expect(r.modified).toBe(1);
    expect((await getPlanByPlanId("toggle"))?.isActive).toBe(false);
  });

  it("returns matched=0 when planId doesn't exist", async () => {
    const r = await setPlanActive("not-found", true);
    expect(r.matched).toBe(0);
  });
});

describe("upsertPlanByPlanId", () => {
  it("inserts when missing", async () => {
    const r = await upsertPlanByPlanId("brand-new", {
      name: "Brand New",
      price: 500,
      directAdminPackage: "DA_NEW",
      quota: 1,
      bandwidth: 10,
    });
    expect(r?.planId).toBe("brand-new");
    expect(r?.price).toBe(500);
  });

  it("merges via $set when the plan already exists", async () => {
    await HostingPlan.create(buildPlanPayload({ planId: "existing", price: 1000 }));
    const r = await upsertPlanByPlanId("existing", { price: 1500 });
    expect(r?.price).toBe(1500);
  });
});
