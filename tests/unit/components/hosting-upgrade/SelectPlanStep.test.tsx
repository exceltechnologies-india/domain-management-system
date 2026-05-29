/**
 * Component tests for <SelectPlanStep> (rescan-4 M14).
 * Step 1 of the hosting-upgrade modal — the plan-list. Companion of
 * <ConfirmStep> (7cg). Pins the current-plan summary, the eligible-plan
 * list with prorated charges, the **subscription-cancel warning gating**,
 * the feature-pill cap (max 3), and the onSelectPlan/onCancel callbacks.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import SelectPlanStep from "@/components/hosting-upgrade/SelectPlanStep";
import type { EligiblePlan, UpgradeInfo } from "@/components/hosting-upgrade/types";

const PLAN_A: EligiblePlan = {
  planId: "biz",
  name: "Business",
  description: "More",
  price: 799,
  currency: "INR",
  features: ["10 GB", "100 GB BW", "Priority support", "Daily backups"],
  quota: 10,
  bandwidth: 100,
  chargeAmount: 521,
  remainingDays: 27,
};
const PLAN_B: EligiblePlan = {
  planId: "biz-plus",
  name: "Business Plus",
  description: "Even more",
  price: 1499,
  currency: "INR",
  features: [],
  quota: 25,
  bandwidth: 250,
  chargeAmount: 1110,
  remainingDays: 27,
};

const UPGRADE: UpgradeInfo = {
  currentPlan: { planId: "starter", name: "Starter", price: 199 },
  eligiblePlans: [PLAN_A, PLAN_B],
  remainingDays: 27,
  hasSubscription: false,
  expiryDate: "2026-12-31",
};

describe("<SelectPlanStep>", () => {
  it("renders the current plan name + price + remaining days", () => {
    render(
      <SelectPlanStep upgradeInfo={UPGRADE} onSelectPlan={vi.fn()} onCancel={vi.fn()} />
    );
    expect(screen.getByText("Starter")).toBeInTheDocument();
    expect(screen.getByText(/₹\s*199/)).toBeInTheDocument();
    expect(screen.getByText(/27 days remaining/)).toBeInTheDocument();
  });

  it("hasSubscription=true shows the cancel-on-upgrade amber warning", () => {
    render(
      <SelectPlanStep
        upgradeInfo={{ ...UPGRADE, hasSubscription: true }}
        onSelectPlan={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(
      screen.getByText(/current subscription will be cancelled/i)
    ).toBeInTheDocument();
  });

  it("hasSubscription=false hides the warning", () => {
    render(
      <SelectPlanStep upgradeInfo={UPGRADE} onSelectPlan={vi.fn()} onCancel={vi.fn()} />
    );
    expect(
      screen.queryByText(/current subscription will be cancelled/i)
    ).not.toBeInTheDocument();
  });

  it("lists every eligible plan with name + prorated charge", () => {
    render(
      <SelectPlanStep upgradeInfo={UPGRADE} onSelectPlan={vi.fn()} onCancel={vi.fn()} />
    );
    expect(screen.getByText("Business")).toBeInTheDocument();
    expect(screen.getByText("Business Plus")).toBeInTheDocument();
    expect(screen.getByText(/₹\s*521/)).toBeInTheDocument();
    expect(screen.getByText(/₹\s*1,110/)).toBeInTheDocument();
  });

  it("feature pills are capped at 3 per plan", () => {
    render(
      <SelectPlanStep upgradeInfo={UPGRADE} onSelectPlan={vi.fn()} onCancel={vi.fn()} />
    );
    // PLAN_A has 4 features; we expect 3 rendered.
    expect(screen.getByText("10 GB")).toBeInTheDocument();
    expect(screen.getByText("100 GB BW")).toBeInTheDocument();
    expect(screen.getByText("Priority support")).toBeInTheDocument();
    expect(screen.queryByText("Daily backups")).not.toBeInTheDocument();
  });

  it("clicking a plan button fires onSelectPlan with the plan object", async () => {
    const user = userEvent.setup();
    const onSelectPlan = vi.fn();
    render(
      <SelectPlanStep upgradeInfo={UPGRADE} onSelectPlan={onSelectPlan} onCancel={vi.fn()} />
    );
    await user.click(screen.getByRole("button", { name: /business plus/i }));
    expect(onSelectPlan).toHaveBeenCalledTimes(1);
    expect(onSelectPlan).toHaveBeenCalledWith(PLAN_B);
  });

  it("Cancel button fires onCancel", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <SelectPlanStep upgradeInfo={UPGRADE} onSelectPlan={vi.fn()} onCancel={onCancel} />
    );
    await user.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
