/**
 * <PanelCheckout> — the paid step for the panel dialogs AND the DMS /cart.
 * Pinned: Razorpay opens with ResellerOS's key + order id; on success nothing
 * else is called (no verify) and onPaid fires; a cart line the mapper refuses
 * is shown and blocks the submit; a cart domain line asks for the address.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({ apiClient: { get: getMock, post: postMock } }));

const openMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/RazorpayCheckoutFrame", () => ({
  useRazorpayCheckout: () => ({ open: openMock, Frame: () => null }),
}));
vi.mock("@/lib/theme-color", () => ({ razorpayThemeColor: () => "#000" }));

import PanelCheckout from "@/components/purchase/PanelCheckout";

const PREFILL = {
  name: "Asha Rao",
  email: "a@example.test",
  phoneOnFile: true,
  companyName: "Rao Traders",
  gstin: "",
  address: { line1: "1 MG Road", city: "Delhi", state: "Delhi", zipcode: "110001" },
};

beforeEach(() => {
  getMock.mockReset().mockResolvedValue({ ok: true, data: PREFILL });
  postMock.mockReset();
  openMock.mockReset();
});

const CART_DOMAIN = { domainName: "rao.in", itemType: "domain", registrationPeriod: 1 };

describe("<PanelCheckout> for the DMS cart", () => {
  it("orders through the route, opens Razorpay with ResellerOS's key, then calls onPaid — and nothing else", async () => {
    postMock.mockResolvedValue({
      ok: true,
      data: { success: true, orderId: "order_R", amount: 70800, currency: "INR", razorpayKeyId: "rzp_ros", quoteId: "Q-1", totalRupees: 708, prefill: { name: "A", email: "a@x", contact: "9" } },
    });
    openMock.mockResolvedValue({ razorpay_payment_id: "pay_1", razorpay_signature: "s" });
    const onPaid = vi.fn();
    const user = userEvent.setup();
    render(<PanelCheckout choice={{ kind: "cart", items: [CART_DOMAIN], label: "1 item" }} onBack={vi.fn()} onClose={vi.fn()} onPaid={onPaid} />);
    await waitFor(() => expect(screen.getByDisplayValue("1 MG Road")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /continue to payment/i }));
    await waitFor(() => expect(screen.getByText("Payment received")).toBeInTheDocument());
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(postMock.mock.calls[0][0]).toBe("/api/v1/user/panel-order");
    expect(postMock.mock.calls[0][1]).toMatchObject({ purchase: { kind: "cart", items: [CART_DOMAIN] }, address: { line1: "1 MG Road" } });
    expect(openMock.mock.calls[0][0]).toMatchObject({ key: "rzp_ros", order_id: "order_R" });
    expect(onPaid).toHaveBeenCalledTimes(1);
  });

  it("a cart line that can't be mapped is shown by name and blocks the submit", async () => {
    render(
      <PanelCheckout
        choice={{ kind: "cart", items: [{ ...CART_DOMAIN, registrationPeriod: 3 }], label: "1 item" }}
        onBack={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(await screen.findByText(/rao\.in is set to 3 years/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue to payment/i })).toBeDisabled();
  });

  it("a hosting-only cart asks for no registrant address", async () => {
    render(
      <PanelCheckout
        choice={{
          kind: "cart",
          items: [{ domainName: "h", itemType: "hosting", billingCycle: "yearly", registrationPeriod: 12, linkedDomain: "rao.in", hostingPlan: { id: "starter", name: "Starter Hosting" } }],
          label: "1 item",
        }}
        onBack={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(await screen.findByText("Starter Hosting for rao.in (1 year)")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Street address")).not.toBeInTheDocument();
  });
});

describe("the checkout page takes no payment on DMS's keys (source scan, comments stripped)", () => {
  it.each(["app/checkout/page.tsx", "components/purchase/PanelCheckout.tsx"])("%s", (f) => {
    const code = readFileSync(path.join(process.cwd(), f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
      .replace(/\{\s*\}/g, "");
    expect(code).not.toMatch(/payments\/create-order|payments\/verify|NEXT_PUBLIC_RAZORPAY_KEY_ID/);
  });
});
