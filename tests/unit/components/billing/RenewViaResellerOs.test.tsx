/**
 * <RenewViaResellerOs> — the Renew dialog on the hosting and domains pages.
 *
 * Until 28 Sep 2026 this pinned "takes no payment: a plain link to ResellerOS's Pay URL".
 * The owner then decided an existing customer renews INSIDE the panel, so the dialog now
 * opens Razorpay here. Pinned now: the order comes only from /api/v1/user/renewal-order
 * (which asks ResellerOS — the price and the bill are ResellerOS's); no DMS renewal or
 * payment route is used; a refusal is shown as written; a closed window says nothing was
 * charged; a read failure is said, never shown as "no bill"; nothing is fetched while closed.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const swr = vi.hoisted(() => ({
  key: undefined as unknown,
  current: { data: undefined as unknown, error: undefined as unknown, isLoading: false },
}));
vi.mock("swr", () => ({
  default: (key: unknown) => {
    swr.key = key;
    return swr.current;
  },
}));
vi.mock("@/lib/fetcher", () => ({ fetcher: vi.fn() }));
vi.mock("@/hooks/useModalScroll", () => ({ useModalScroll: () => {} }));
const postMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({ apiClient: { post: postMock } }));
const openMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/RazorpayCheckoutFrame", () => ({
  useRazorpayCheckout: () => ({ open: openMock, Frame: () => null }),
}));
vi.mock("@/lib/theme-color", () => ({ razorpayThemeColor: () => "#000" }));

import RenewViaResellerOs from "@/components/billing/RenewViaResellerOs";

const open = () =>
  render(<RenewViaResellerOs isOpen onClose={() => {}} serviceName="example.in" serviceType="hosting" />);
const oneBill = () => {
  swr.current = {
    data: { state: "ok", quotes: [{ id: "Q-9", amount: 708, status: "pending", paymentUrl: "https://ros.test/quote/Q-9/accept" }] },
    error: undefined,
    isLoading: false,
  };
};
const order = {
  orderId: "order_9", amount: 70800, currency: "INR", razorpayKeyId: "rzp_test_k", quoteId: "Q-9",
  prefill: { name: "Asha", email: "asha@example.invalid", contact: "9876543210" },
};

beforeEach(() => {
  swr.key = undefined;
  swr.current = { data: undefined, error: undefined, isLoading: false };
  postMock.mockReset();
  openMock.mockReset();
});

describe("<RenewViaResellerOs>", () => {
  it("fetches nothing while closed", () => {
    render(<RenewViaResellerOs isOpen={false} onClose={() => {}} serviceName="x.in" serviceType="domain" />);
    expect(swr.key).toBeNull();
  });

  it("Pay asks ResellerOS for the order, opens Razorpay in the panel, then says it was received", async () => {
    oneBill();
    postMock.mockResolvedValue({ ok: true, data: order });
    openMock.mockResolvedValue({ razorpay_payment_id: "pay_9" });
    open();
    fireEvent.click(screen.getByRole("button", { name: /Pay ₹708/ }));
    await waitFor(() => expect(screen.getByText("Payment received")).toBeInTheDocument());
    expect(postMock).toHaveBeenCalledWith("/api/v1/user/renewal-order", { quoteId: "Q-9" });
    expect(openMock.mock.calls[0][0]).toMatchObject({ key: "rzp_test_k", order_id: "order_9", amount: 70800 });
    expect(screen.getByText(/\(Q-9\)/)).toBeInTheDocument();
  });

  it("a refusal is shown as ResellerOS wrote it, and Razorpay never opens", async () => {
    oneBill();
    postMock.mockResolvedValue({ ok: false, error: { status: 409, message: "This quote is already paid." } });
    open();
    fireEvent.click(screen.getByRole("button", { name: /Pay ₹708/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("This quote is already paid."));
    expect(openMock).not.toHaveBeenCalled();
  });

  it("closing the payment window says nothing was charged and lets them pay again", async () => {
    oneBill();
    postMock.mockResolvedValue({ ok: true, data: order });
    openMock.mockRejectedValue({ kind: "dismissed" });
    open();
    fireEvent.click(screen.getByRole("button", { name: /Pay ₹708/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Nothing was charged.*Q-9 is still unpaid/));
    expect(screen.getByRole("button", { name: /Pay ₹708/ })).toBeEnabled();
  });

  it("no pending bill → explains ResellerOS emails one, and offers support", () => {
    swr.current = { data: { state: "no_bills" }, error: undefined, isLoading: false };
    open();
    expect(screen.getByText(/no renewal bill for example\.in to pay yet/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Contact support" })).toHaveAttribute("href", "/dashboard/support");
  });

  it("a failed read says so — it never claims there is no bill", () => {
    swr.current = { data: undefined, error: new Error("500"), isLoading: false };
    open();
    expect(screen.getByRole("alert")).toHaveTextContent(/can't tell whether one is waiting/);
    expect(screen.queryByText(/no renewal bill/)).not.toBeInTheDocument();
  });

  it("uses no DMS renewal or payment route (source scan, comments stripped)", () => {
    const code = readFileSync(path.join(process.cwd(), "components/billing/RenewViaResellerOs.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/hosting\/renew|payments\/verify|payments\/create-order|domains\/renew/);
    expect(code).toMatch(/\/api\/v1\/user\/renewal-order/);
  });
});
