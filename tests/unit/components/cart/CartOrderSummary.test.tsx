/**
 * Component tests for <CartOrderSummary> (rescan-4 M14 — cart UI slice).
 * Pins the conditional checkout-label states, the GST/subtotal math, the
 * item-count pluralisation, the action callbacks, and (since 25 Sep 2026)
 * that no guest checkout is offered. next/link renders a plain <a> under
 * jsdom so href assertions work without a mock.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import CartOrderSummary from "@/components/cart/CartOrderSummary";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

type Props = React.ComponentProps<typeof CartOrderSummary>;

function renderSummary(overrides: Partial<Props> = {}) {
  const props: Props = {
    isLoggedIn: true,
    hasSession: true,
    profileCompleted: true,
    itemCount: 2,
    totalPrice: 1180,
    onCheckout: vi.fn(),
    onClearCart: vi.fn(),
    returnUrl: "/cart",
    ...overrides,
  };
  render(<CartOrderSummary {...props} />);
  return props;
}

beforeEach(() => {
  pushMock.mockClear();
});

describe("<CartOrderSummary>", () => {
  it("pluralises the item count", () => {
    renderSummary({ itemCount: 1 });
    expect(screen.getByText("1 item")).toBeInTheDocument();
  });

  it("uses the plural form for multiple items", () => {
    renderSummary({ itemCount: 3 });
    expect(screen.getByText("3 items")).toBeInTheDocument();
  });

  it("derives subtotal and GST from the GST-inclusive total", () => {
    // totalPrice is GST-inclusive: subtotal = total / 1.18, gst = total - subtotal
    renderSummary({ totalPrice: 1180 });
    expect(screen.getByText("₹1000.00")).toBeInTheDocument(); // subtotal
    expect(screen.getByText("₹180.00")).toBeInTheDocument();  // gst
    expect(screen.getByText("₹1180.00")).toBeInTheDocument(); // total
  });

  it("shows 'Login to Checkout' when not logged in", () => {
    renderSummary({ isLoggedIn: false, hasSession: false });
    expect(screen.getByRole("button", { name: /login to checkout/i })).toBeInTheDocument();
  });

  it("shows 'Proceed to Checkout' when logged in with a complete profile", () => {
    renderSummary({ isLoggedIn: true, profileCompleted: true });
    expect(screen.getByRole("button", { name: /proceed to checkout/i })).toBeInTheDocument();
  });

  it("shows 'Complete Profile First' when logged in without a complete profile", () => {
    renderSummary({ isLoggedIn: true, profileCompleted: false });
    expect(screen.getByRole("button", { name: /complete profile first/i })).toBeInTheDocument();
  });

  it("fires onCheckout and onClearCart", async () => {
    const user = userEvent.setup();
    const props = renderSummary();
    await user.click(screen.getByRole("button", { name: /proceed to checkout/i }));
    await user.click(screen.getByRole("button", { name: /clear cart/i }));
    expect(props.onCheckout).toHaveBeenCalledTimes(1);
    expect(props.onClearCart).toHaveBeenCalledTimes(1);
  });

  // Guest checkout was removed on 25 Sep 2026: it took payment on DMS's
  // own Razorpay account. A visitor signs in or creates an account.
  it("offers no guest checkout to a signed-out visitor", () => {
    renderSummary({ isLoggedIn: false, hasSession: false });
    expect(screen.queryByRole("button", { name: /continue as guest/i })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("you@example.com")).not.toBeInTheDocument();
  });

  it("offers account creation for unauthenticated users", () => {
    renderSummary({ isLoggedIn: false, hasSession: false });
    expect(screen.getByRole("link", { name: /create an account/i })).toHaveAttribute(
      "href",
      "/register?returnUrl=%2Fcart"
    );
  });
});
