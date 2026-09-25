import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isTrialPlan } from "@/lib/pricing/trial-plan";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("only Starter has a free trial (owner, 24 Sep 2026)", () => {
  it("Starter in either case is eligible; nothing else is", () => {
    expect(isTrialPlan("starter")).toBe(true);
    expect(isTrialPlan("Starter")).toBe(true);
    for (const p of ["standard", "Plus", "", null, undefined]) expect(isTrialPlan(p), String(p)).toBe(false);
  });

  it("both server gates check it — the dialog hiding the button is not the rule", () => {
    expect(src("app/api/user/hosting/trial-eligibility/route.ts")).toMatch(/isTrialPlan\(body\.planId\)/);
    expect(src("app/api/user/hosting/start-trial/route.ts")).toMatch(/isTrialPlan\(item\.hostingPlan\?\.id\)/);
  });
});
