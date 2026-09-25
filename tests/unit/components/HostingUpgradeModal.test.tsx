/**
 * Component tests for <HostingUpgradeModal> — since 25 Sep 2026 an upgrade
 * REQUEST billed by ResellerOS (owner: "Request, billed by ResellerOS").
 *
 * Step machine: loading → select → confirm → sending → requested
 *                                                    ↘ error
 * Pinned: no Razorpay and no /payments/verify anywhere; the request posts to
 * /api/v1/user/hosting/upgrade; success says a quote follows and the plan
 * changes once it is paid; a refusal shows the route's own message.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const selectStepMock = vi.hoisted(() =>
  vi.fn(({ onSelectPlan }: { onSelectPlan: (plan: { planId: string; name: string }) => void }) => (
    <div data-testid="select-step">
      <button onClick={() => onSelectPlan({ planId: "Plus", name: "Plus" })}>pick-plus</button>
    </div>
  ))
);
vi.mock("@/components/hosting-upgrade/SelectPlanStep", () => ({ default: selectStepMock }));

const confirmStepMock = vi.hoisted(() =>
  vi.fn(({ onRequest }: { onRequest: () => void }) => (
    <div data-testid="confirm-step">
      <button onClick={onRequest}>request</button>
    </div>
  ))
);
vi.mock("@/components/hosting-upgrade/ConfirmStep", () => ({ default: confirmStepMock }));

import HostingUpgradeModal from "@/components/HostingUpgradeModal";

const fetchMock = vi.fn();
const INFO = {
  success: true,
  data: {
    currentPlan: { planId: "starter", name: "Starter", price: 59 },
    eligiblePlans: [{ planId: "Plus", name: "Plus", chargeAmount: 300 }],
    remainingDays: 100,
    hasSubscription: false,
    expiryDate: "2027-01-01",
  },
};

function json(status: number, body: unknown) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

async function toConfirm() {
  const user = userEvent.setup();
  render(<HostingUpgradeModal isOpen onClose={() => {}} domainName="example.in" />);
  await waitFor(() => expect(screen.getByTestId("select-step")).toBeInTheDocument());
  await user.click(screen.getByText("pick-plus"));
  return user;
}

describe("<HostingUpgradeModal>", () => {
  it("sends the request and says a quote follows; the plan changes once it is paid", async () => {
    fetchMock.mockImplementation((url: string) =>
      String(url).includes("upgrade-info") ? json(200, INFO) : json(200, { success: true, data: { alreadyRequested: false } })
    );
    const user = await toConfirm();
    await user.click(screen.getByText("request"));
    await waitFor(() => expect(screen.getByText("Upgrade requested")).toBeInTheDocument());
    expect(screen.getByText(/Your plan changes once that\s+quote is paid/)).toBeInTheDocument();
    const post = fetchMock.mock.calls.find((c) => String(c[0]) === "/api/v1/user/hosting/upgrade");
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({ domainName: "example.in", targetPlanId: "Plus" });
  });

  it("an existing open request is acknowledged as such", async () => {
    fetchMock.mockImplementation((url: string) =>
      String(url).includes("upgrade-info") ? json(200, INFO) : json(200, { success: true, data: { alreadyRequested: true } })
    );
    const user = await toConfirm();
    await user.click(screen.getByText("request"));
    await waitFor(() => expect(screen.getByText("You have already asked for this upgrade")).toBeInTheDocument());
  });

  it("a refusal shows the route's own message", async () => {
    fetchMock.mockImplementation((url: string) =>
      String(url).includes("upgrade-info")
        ? json(200, INFO)
        : json(503, { error: "We couldn't confirm your upgrade request. Nothing was charged." })
    );
    const user = await toConfirm();
    await user.click(screen.getByText("request"));
    await waitFor(() => expect(screen.getByText("We couldn't confirm your upgrade request. Nothing was charged.")).toBeInTheDocument());
  });

  it("a network failure says nothing was sent", async () => {
    fetchMock.mockImplementation((url: string) => (String(url).includes("upgrade-info") ? json(200, INFO) : Promise.reject(new TypeError("offline"))));
    const user = await toConfirm();
    await user.click(screen.getByText("request"));
    await waitFor(() => expect(screen.getByText(/the request wasn't sent\. Nothing was charged/)).toBeInTheDocument());
  });

  it("no plans to move to → says so", async () => {
    fetchMock.mockImplementation(() => json(200, { ...INFO, data: { ...INFO.data, eligiblePlans: [] } }));
    render(<HostingUpgradeModal isOpen onClose={() => {}} domainName="example.in" />);
    await waitFor(() => expect(screen.getByText("You are already on the highest available plan.")).toBeInTheDocument());
  });

  it("takes no payment (source scan, comments stripped)", () => {
    const code = readFileSync(path.join(process.cwd(), "components/HostingUpgradeModal.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/RazorpayCheckout|payments\/verify|RAZORPAY_KEY/);
  });
});
