/**
 * The in-panel purchase dialogs (owner decision, 24 Sep 2026).
 *
 *  - `?buy=` opens exactly the named dialog, and closing strips only the
 *    dialog's own parameters.
 *  - A PAID plan or domain no longer goes into DMS's cart (owner decision 30,
 *    25 Sep 2026): it opens PanelCheckout with the choice, which orders it
 *    through ResellerOS. Only the ₹0 trial still uses the cart.
 *  - The trial is refused client-side when the eligibility check says no, and
 *    an unreachable check is reported rather than read as "eligible".
 */
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const pushMock = vi.hoisted(() => vi.fn());
const replaceMock = vi.hoisted(() => vi.fn());
const searchParams = vi.hoisted(() => ({ value: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  usePathname: () => "/dashboard/hosting",
  useSearchParams: () => searchParams.value,
}));

const addItemMock = vi.hoisted(() => vi.fn());
vi.mock("@/store/cartStore", () => ({
  useCartStore: () => ({ addItem: addItemMock, items: [] }),
}));

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("react-hot-toast", () => ({ default: toastMock }));

const postMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({ apiClient: { post: postMock } }));
vi.mock("@/lib/device-fingerprint", () => ({ getDeviceFingerprint: () => Promise.resolve("fp") }));
vi.mock("@/lib/journey", () => ({ trackStartTrial: vi.fn() }));
vi.mock("@/hooks/useModalScroll", () => ({ useModalScroll: () => {} }));

// The domain dialog is DomainSearch in a frame; DomainSearch has its own suite.
const domainSearchMock = vi.hoisted(() =>
  vi.fn((props: { initialSearchTerm?: string; autoSearch?: boolean; onSelectDomain?: (d: string) => void }) => (
    <div data-testid="domain-search" data-term={props.initialSearchTerm} data-auto={String(props.autoSearch)} />
  ))
);
vi.mock("@/components/DomainSearch", () => ({ default: domainSearchMock }));

// PanelCheckout has its own suite; here we only need to see WHAT it was handed.
vi.mock("@/components/purchase/PanelCheckout", () => ({
  default: (props: { choice: unknown }) => <pre data-testid="panel-checkout">{JSON.stringify(props.choice)}</pre>,
}));

import PurchaseDialogs from "@/components/purchase/PurchaseDialogs";

function open(qs: string) {
  searchParams.value = new URLSearchParams(qs);
  return render(<PurchaseDialogs />);
}

beforeEach(() => {
  pushMock.mockReset();
  replaceMock.mockReset();
  addItemMock.mockReset();
  postMock.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
});

describe("which dialog opens", () => {
  it("nothing without ?buy=", () => {
    open("");
    expect(screen.queryByText("Buy hosting")).toBeNull();
    expect(screen.queryByTestId("domain-search")).toBeNull();
  });

  it("?buy=hosting opens only the hosting dialog", () => {
    open("buy=hosting");
    expect(screen.getByText("Buy hosting")).toBeInTheDocument();
    expect(screen.queryByTestId("domain-search")).toBeNull();
  });

  it("?buy=domain opens the search, pre-filled and run from ?q=", () => {
    open("buy=domain&q=example");
    const s = screen.getByTestId("domain-search");
    expect(s).toHaveAttribute("data-term", "example");
    expect(s).toHaveAttribute("data-auto", "true");
  });

  it("closing removes buy and q, keeps anything else, and does not push history", () => {
    open("buy=domain&q=example&tab=active");
    fireEvent.click(screen.getByRole("button", { name: "" }));
    expect(replaceMock).toHaveBeenCalledWith("/dashboard/hosting?tab=active", { scroll: false });
  });
});

describe("the hosting dialog", () => {
  it("shows ResellerOS's Starter year (₹708 incl. GST) and Buy opens the ResellerOS checkout, not the cart", () => {
    open("buy=hosting");
    expect(screen.getAllByText(/₹708 a year including 18% GST/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Buy Starter" }));
    expect(addItemMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
    const choice = JSON.parse(screen.getByTestId("panel-checkout").textContent ?? "{}");
    expect(choice).toMatchObject({ kind: "hosting", planId: "starter", cycle: "yearly" });
  });

  it("monthly shows ResellerOS's ₹100 + GST and hands the monthly cycle to checkout", () => {
    open("buy=hosting");
    fireEvent.click(screen.getByRole("button", { name: "Monthly" }));
    expect(screen.getByText("₹100")).toBeInTheDocument();
    expect(screen.getByText(/₹118 a month including 18% GST/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Buy Starter" }));
    expect(addItemMock).not.toHaveBeenCalled();
    const choice = JSON.parse(screen.getByTestId("panel-checkout").textContent ?? "{}");
    expect(choice).toMatchObject({ kind: "hosting", planId: "starter", cycle: "monthly" });
  });

  // Owner, 24 Sep 2026: the trial is on Starter only, on monthly AND yearly.
  // This used to pin "yearly only" (no button on Monthly).
  it("offers the trial on Starter only, on both yearly and monthly", () => {
    open("buy=hosting");
    expect(screen.getAllByRole("button", { name: /free trial/i })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Monthly" }));
    expect(screen.getAllByRole("button", { name: /free trial/i })).toHaveLength(1);
  });

  it("a trial started on Monthly converts to monthly billing", async () => {
    postMock.mockResolvedValue({ ok: true, data: { eligible: true } });
    open("buy=hosting");
    fireEvent.click(screen.getByRole("button", { name: "Monthly" }));
    fireEvent.click(screen.getByRole("button", { name: /free trial/i }));
    await waitFor(() => expect(addItemMock).toHaveBeenCalled());
    expect(addItemMock.mock.calls[0][0]).toMatchObject({ price: 0, isTrial: true, billingCycle: "monthly" });
    expect(postMock.mock.calls[0][1]).toMatchObject({ planId: "starter" });
  });

  it("an eligible trial adds a ₹0 line and goes to the cart", async () => {
    postMock.mockResolvedValue({ ok: true, data: { eligible: true } });
    open("buy=hosting");
    fireEvent.click(screen.getByRole("button", { name: /free trial/i }));
    await waitFor(() => expect(addItemMock).toHaveBeenCalled());
    expect(addItemMock.mock.calls[0][0]).toMatchObject({ price: 0, isTrial: true });
    expect(pushMock).toHaveBeenCalledWith("/cart");
  });

  it("an ineligible trial says why and adds nothing", async () => {
    postMock.mockResolvedValue({ ok: true, data: { eligible: false, reason: "You have already used your free trial" } });
    open("buy=hosting");
    fireEvent.click(screen.getByRole("button", { name: /free trial/i }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("You have already used your free trial"));
    expect(addItemMock).not.toHaveBeenCalled();
  });

  it("a failed eligibility check is reported, never treated as eligible", async () => {
    postMock.mockResolvedValue({ ok: false });
    open("buy=hosting");
    fireEvent.click(screen.getByRole("button", { name: /free trial/i }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    expect(addItemMock).not.toHaveBeenCalled();
  });
});

describe("the domain dialog", () => {
  it("choosing a name opens the ResellerOS checkout for that exact name, not the cart", () => {
    open("buy=domain");
    const props = domainSearchMock.mock.calls.at(-1)?.[0] as { onSelectDomain?: (d: string) => void };
    expect(typeof props.onSelectDomain).toBe("function");
    act(() => props.onSelectDomain?.("example.in"));
    const choice = JSON.parse(screen.getByTestId("panel-checkout").textContent ?? "{}");
    expect(choice).toMatchObject({ kind: "domain", domain: "example.in" });
    expect(addItemMock).not.toHaveBeenCalled();
  });
});
