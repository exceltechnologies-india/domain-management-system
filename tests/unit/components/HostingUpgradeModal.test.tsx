/**
 * Component tests for <HostingUpgradeModal> (rescan-4 M14).
 * The full hosting-upgrade orchestration component. Subcomponents
 * SelectPlanStep + ConfirmStep already have their own tests (7cg + 7ch);
 * here we focus on the step machine:
 *   loading → select → confirm → paying → verifying → success
 *                                       ↘ error
 *
 * Heavy mock setup:
 *  - global.fetch (upgrade-info + upgrade order create + payment verify)
 *  - next-auth/react.useSession
 *  - next/navigation.useRouter
 *  - useRazorpayCheckout (open + Frame)
 *  - SelectPlanStep / ConfirmStep replaced with thin mock components
 *    exposing props via test-only buttons
 */
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

const useSessionMock = vi.hoisted(() => vi.fn(() => ({ data: { user: { email: "a@b.com" } } })));
vi.mock("next-auth/react", () => ({ useSession: useSessionMock }));

const pushMock = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

const sessionStore = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/storage", () => ({
  safeSessionStorage: {
    getItem: (k: string) => sessionStore.get(k) ?? null,
    setItem: (k: string, v: string) => sessionStore.set(k, v),
  },
}));

const razorpayOpenMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/RazorpayCheckoutFrame", () => ({
  useRazorpayCheckout: () => ({
    open: razorpayOpenMock,
    Frame: () => <div data-testid="rzp-frame" />,
  }),
}));

const selectStepMock = vi.hoisted(() =>
  vi.fn(
    ({
      onSelectPlan,
      onCancel,
    }: {
      onSelectPlan: (plan: { planId: string; name: string }) => void;
      onCancel: () => void;
    }) => (
      <div data-testid="select-step">
        <button onClick={() => onSelectPlan({ planId: "biz", name: "Business" })}>
          pick-business
        </button>
        <button onClick={onCancel}>cancel-select</button>
      </div>
    )
  )
);
vi.mock("@/components/hosting-upgrade/SelectPlanStep", () => ({ default: selectStepMock }));

const confirmStepMock = vi.hoisted(() =>
  vi.fn(({ onBack, onPay }: { onBack: () => void; onPay: () => void }) => (
    <div data-testid="confirm-step">
      <button onClick={onBack}>back-confirm</button>
      <button onClick={onPay}>pay</button>
    </div>
  ))
);
vi.mock("@/components/hosting-upgrade/ConfirmStep", () => ({ default: confirmStepMock }));

import HostingUpgradeModal from "@/components/HostingUpgradeModal";

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  razorpayOpenMock.mockReset();
  pushMock.mockReset();
  selectStepMock.mockClear();
  confirmStepMock.mockClear();
  sessionStore.clear();
});

const upgradeInfoOk = (eligible = 1) => ({
  ok: true,
  json: async () => ({
    data: {
      currentPlan: { planId: "starter", name: "Starter", price: 199 },
      eligiblePlans: Array.from({ length: eligible }, (_, i) => ({
        planId: `plan-${i}`,
        name: `Plan ${i}`,
        description: "x",
        price: 999,
        currency: "INR",
        features: [],
        quota: 10,
        bandwidth: 100,
        chargeAmount: 500,
        remainingDays: 30,
      })),
      remainingDays: 30,
      hasSubscription: false,
      expiryDate: "2026-12-31",
    },
  }),
});

const upgradeInfoFail = (status = 500, error = "boom") => ({
  ok: false,
  status,
  json: async () => ({ error }),
});

describe("<HostingUpgradeModal>", () => {
  it("isOpen=false renders nothing", () => {
    render(<HostingUpgradeModal isOpen={false} onClose={vi.fn()} domainName="x.com" />);
    expect(screen.queryByText(/upgrade hosting plan/i)).not.toBeInTheDocument();
  });

  it("isOpen=true → fetches /upgrade-info and shows the loading step initially", () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {})); // pending forever
    render(<HostingUpgradeModal isOpen onClose={vi.fn()} domainName="x.com" />);
    expect(screen.getByText(/loading upgrade options/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/user/hosting/upgrade-info?domainName=x.com"),
      expect.objectContaining({ credentials: "include" })
    );
  });

  it("upgrade-info success + eligiblePlans>0 → 'select' step renders SelectPlanStep", async () => {
    fetchMock.mockResolvedValueOnce(upgradeInfoOk(2));
    render(<HostingUpgradeModal isOpen onClose={vi.fn()} domainName="x.com" />);
    await waitFor(() => expect(screen.getByTestId("select-step")).toBeInTheDocument());
  });

  it("eligiblePlans=0 → 'error' step with the highest-plan copy", async () => {
    fetchMock.mockResolvedValueOnce(upgradeInfoOk(0));
    render(<HostingUpgradeModal isOpen onClose={vi.fn()} domainName="x.com" />);
    await waitFor(() =>
      expect(screen.getByText(/highest available plan/i)).toBeInTheDocument()
    );
  });

  it("upgrade-info HTTP error → 'error' step with the server message", async () => {
    fetchMock.mockResolvedValueOnce(upgradeInfoFail(500, "server-down"));
    render(<HostingUpgradeModal isOpen onClose={vi.fn()} domainName="x.com" />);
    await waitFor(() => expect(screen.getByText("server-down")).toBeInTheDocument());
  });

  it("fetch throws → 'error' step with the generic retry copy", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network"));
    render(<HostingUpgradeModal isOpen onClose={vi.fn()} domainName="x.com" />);
    await waitFor(() =>
      expect(screen.getByText(/failed to load upgrade options/i)).toBeInTheDocument()
    );
  });

  it("picking a plan transitions to the 'confirm' step", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(upgradeInfoOk(2));
    render(<HostingUpgradeModal isOpen onClose={vi.fn()} domainName="x.com" />);
    await waitFor(() => expect(screen.getByTestId("select-step")).toBeInTheDocument());
    await user.click(screen.getByText("pick-business"));
    expect(screen.getByTestId("confirm-step")).toBeInTheDocument();
    expect(screen.queryByTestId("select-step")).not.toBeInTheDocument();
  });

  it("confirm back → returns to 'select' step", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(upgradeInfoOk(2));
    render(<HostingUpgradeModal isOpen onClose={vi.fn()} domainName="x.com" />);
    await waitFor(() => expect(screen.getByTestId("select-step")).toBeInTheDocument());
    await user.click(screen.getByText("pick-business"));
    await user.click(screen.getByText("back-confirm"));
    expect(screen.getByTestId("select-step")).toBeInTheDocument();
  });

  it("razorpay dismissed during Pay → soft-cancel back to 'confirm' step", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(upgradeInfoOk(2));
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { razorpayOrderId: "ord_1", amount: 500, currency: "INR" } }),
    });
    razorpayOpenMock.mockRejectedValueOnce({ kind: "dismissed" });
    render(<HostingUpgradeModal isOpen onClose={vi.fn()} domainName="x.com" />);
    await waitFor(() => expect(screen.getByTestId("select-step")).toBeInTheDocument());
    await user.click(screen.getByText("pick-business"));
    await act(async () => {
      await user.click(screen.getByText("pay"));
    });
    await waitFor(() => expect(screen.getByTestId("confirm-step")).toBeInTheDocument());
  });

  it("upgrade order create fails → 'error' step with server message", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(upgradeInfoOk(2));
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Razorpay order init failed" }),
    });
    render(<HostingUpgradeModal isOpen onClose={vi.fn()} domainName="x.com" />);
    await waitFor(() => expect(screen.getByTestId("select-step")).toBeInTheDocument());
    await user.click(screen.getByText("pick-business"));
    await act(async () => {
      await user.click(screen.getByText("pay"));
    });
    await waitFor(() =>
      expect(screen.getByText("Razorpay order init failed")).toBeInTheDocument()
    );
  });

  it("error step → Retry refetches upgrade-info", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(upgradeInfoFail());
    fetchMock.mockResolvedValueOnce(upgradeInfoOk(1));
    render(<HostingUpgradeModal isOpen onClose={vi.fn()} domainName="x.com" />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument()
    );
    await user.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(screen.getByTestId("select-step")).toBeInTheDocument());
  });
});
