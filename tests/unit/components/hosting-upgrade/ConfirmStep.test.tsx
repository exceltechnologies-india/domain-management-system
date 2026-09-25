/**
 * Component tests for <ConfirmStep> (rescan-4 M14).
 * The third step of the hosting-upgrade modal. Pins the plan summary
 * (target name + 'From' current + remaining days), the prorated figure
 * labelled as an estimate, and the Back / Request-upgrade callbacks. Since
 * 25 Sep 2026 an upgrade is a request billed by ResellerOS, not a payment.
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

describe("<ConfirmStep> — an upgrade REQUEST (owner decision, 25 Sep 2026)", () => {
  const renderStep = (overrides: Partial<React.ComponentProps<typeof ConfirmStep>> = {}) =>
    render(
      <ConfirmStep upgradeInfo={UPGRADE} selectedPlan={PLAN} onBack={vi.fn()} onRequest={vi.fn()} {...overrides} />
    );

  it("renders the target plan name + From current + remaining days", () => {
    renderStep();
    expect(screen.getByText("Business Plus")).toBeInTheDocument();
    expect(screen.getByText("Starter")).toBeInTheDocument();
    expect(screen.getByText("42 days")).toBeInTheDocument();
  });

  it("labels the prorated figure an ESTIMATE, and says the quote is the price", () => {
    renderStep();
    expect(screen.getByText("Estimated charge")).toBeInTheDocument();
    expect(screen.getAllByText(/₹\s*1,234/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/The amount you pay is the one on the\s+quote/)).toBeInTheDocument();
  });

  it("says the plan changes once the quote is paid, and never claims a subscription is cancelled", () => {
    renderStep({ upgradeInfo: { ...UPGRADE, hasSubscription: true } });
    expect(screen.getByText(/plan changes once the quote is paid/i)).toBeInTheDocument();
    expect(screen.queryByText(/subscription will be cancelled/i)).not.toBeInTheDocument();
  });

  it("offers Request upgrade — no Pay button", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const onRequest = vi.fn();
    renderStep({ onBack, onRequest });
    expect(screen.queryByRole("button", { name: /pay/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /back/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: /request upgrade/i }));
    expect(onRequest).toHaveBeenCalledTimes(1);
  });
});
