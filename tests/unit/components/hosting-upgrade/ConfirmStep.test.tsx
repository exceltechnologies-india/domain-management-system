/**
 * Component tests for <ConfirmStep> (rescan-4 M14).
 * The third step of the hosting-upgrade modal. Pins the plan summary
 * (target name + 'From' current + remaining days), the prorated-charge
 * row using formatIndianCurrency, the subscription-cancel warning
 * gated by `upgradeInfo.hasSubscription`, the Pay button label
 * including the formatted amount, and the Back/Pay callbacks.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import ConfirmStep from "@/components/hosting-upgrade/ConfirmStep";
import type { EligiblePlan, UpgradeInfo } from "@/components/hosting-upgrade/types";

const PLAN: EligiblePlan = {
  planId: "biz-plus",
  name: "Business Plus",
  description: "Bigger quota + priority support.",
  price: 999,
  currency: "INR",
  features: ["10 GB disk", "100 GB bandwidth"],
  quota: 10,
  bandwidth: 100,
  chargeAmount: 1234,
  remainingDays: 42,
};

const UPGRADE: UpgradeInfo = {
  currentPlan: { planId: "starter", name: "Starter", price: 199 },
  eligiblePlans: [PLAN],
  remainingDays: 42,
  hasSubscription: false,
  expiryDate: "2026-12-31",
};

describe("<ConfirmStep>", () => {
  it("renders the target plan name + From current + remaining days", () => {
    render(
      <ConfirmStep
        upgradeInfo={UPGRADE}
        selectedPlan={PLAN}
        onBack={vi.fn()}
        onPay={vi.fn()}
      />
    );
    expect(screen.getByText("Business Plus")).toBeInTheDocument();
    expect(screen.getByText("Starter")).toBeInTheDocument();
    expect(screen.getByText("42 days")).toBeInTheDocument();
  });

  it("renders the prorated charge using the formatIndianCurrency helper (₹1,234)", () => {
    render(
      <ConfirmStep
        upgradeInfo={UPGRADE}
        selectedPlan={PLAN}
        onBack={vi.fn()}
        onPay={vi.fn()}
      />
    );
    // formatIndianCurrency emits ₹ + Indian-locale-grouped integer.
    expect(screen.getAllByText(/₹\s*1,234/).length).toBeGreaterThanOrEqual(1);
  });

  it("hasSubscription=true shows the cancel-subscription amber warning", () => {
    render(
      <ConfirmStep
        upgradeInfo={{ ...UPGRADE, hasSubscription: true }}
        selectedPlan={PLAN}
        onBack={vi.fn()}
        onPay={vi.fn()}
      />
    );
    expect(
      screen.getByText(/active subscription will be cancelled immediately/i)
    ).toBeInTheDocument();
  });

  it("hasSubscription=false hides the cancel warning", () => {
    render(
      <ConfirmStep
        upgradeInfo={UPGRADE}
        selectedPlan={PLAN}
        onBack={vi.fn()}
        onPay={vi.fn()}
      />
    );
    expect(
      screen.queryByText(/active subscription will be cancelled/i)
    ).not.toBeInTheDocument();
  });

  it("Back button fires onBack; Pay button fires onPay", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const onPay = vi.fn();
    render(
      <ConfirmStep
        upgradeInfo={UPGRADE}
        selectedPlan={PLAN}
        onBack={onBack}
        onPay={onPay}
      />
    );
    await user.click(screen.getByRole("button", { name: /back/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: /pay/i }));
    expect(onPay).toHaveBeenCalledTimes(1);
  });

  it("Pay button label includes the formatted charge amount", () => {
    render(
      <ConfirmStep
        upgradeInfo={UPGRADE}
        selectedPlan={PLAN}
        onBack={vi.fn()}
        onPay={vi.fn()}
      />
    );
    const payBtn = screen.getByRole("button", { name: /pay.*1,234/i });
    expect(payBtn).toBeInTheDocument();
  });
});
