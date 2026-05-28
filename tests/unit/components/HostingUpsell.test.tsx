/**
 * Component tests for <HostingUpsell> (rescan-4 M14).
 * The component is the "Add Standard Hosting" upsell card on the cart page.
 * Tests cover: the static card render (heading, prices, "Save 50%", features
 * list, button), the add-to-cart success path (hosting item shape, default
 * registrationPeriod=12, billingCycle='yearly'), the auto-link to an existing
 * domain in cart (sets `linkedDomain`), no-link when the cart has no domain,
 * the "already in cart" dedupe (toast.error + skipped addItem), and the
 * success toast.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { CartItem } from "@/lib/types";

const { mockUseCartStore, mockToast } = vi.hoisted(() => {
  const toast = vi.fn() as unknown as ((...args: unknown[]) => unknown) & {
    error: ReturnType<typeof vi.fn>;
    success: ReturnType<typeof vi.fn>;
  };
  toast.error = vi.fn();
  toast.success = vi.fn();
  return {
    mockUseCartStore: vi.fn(),
    mockToast: toast,
  };
});

vi.mock("@/store/cartStore", () => ({ useCartStore: mockUseCartStore }));
vi.mock("react-hot-toast", () => ({ default: mockToast, toast: mockToast }));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), log: vi.fn() },
}));

import HostingUpsell from "@/components/HostingUpsell";
import { HOSTING_PLANS } from "@/config/hosting-plans";

function setCart(items: CartItem[]) {
  const addItem = vi.fn();
  mockUseCartStore.mockReturnValue({ addItem, items });
  return addItem;
}

beforeEach(() => {
  mockToast.error.mockClear();
  mockToast.success.mockClear();
  mockUseCartStore.mockReset();
});

describe("<HostingUpsell>", () => {
  it("renders the standard plan card with heading, prices, and Save 50% badge", () => {
    setCart([]);
    render(<HostingUpsell />);
    expect(screen.getByRole("heading", { name: /add standard/i })).toBeInTheDocument();
    expect(screen.getByText(`₹${HOSTING_PLANS.standard.price}`)).toBeInTheDocument();
    expect(screen.getByText(`₹${HOSTING_PLANS.standard.price * 2}`)).toBeInTheDocument();
    expect(screen.getByText(/save 50%/i)).toBeInTheDocument();
    expect(screen.getByText(/30-day money-back guarantee/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add hosting/i })).toBeInTheDocument();
  });

  it("adds a hosting CartItem with the right defaults on click", async () => {
    const user = userEvent.setup();
    const addItem = setCart([]);
    render(<HostingUpsell />);
    await user.click(screen.getByRole("button", { name: /add hosting/i }));
    expect(addItem).toHaveBeenCalledTimes(1);
    const item = addItem.mock.calls[0][0] as CartItem;
    expect(item).toMatchObject({
      itemType: "hosting",
      registrationPeriod: 12,
      billingCycle: "yearly",
      currency: "INR",
      price: HOSTING_PLANS.standard.price,
      hostingPlan: expect.objectContaining({ id: HOSTING_PLANS.standard.id }),
    });
    expect(item.domainName).toMatch(/^hosting-/);
    expect(item.linkedDomain).toBeUndefined();
    expect(mockToast.success).toHaveBeenCalledWith(expect.stringMatching(/added to cart/i));
  });

  it("auto-links to an existing domain in the cart via linkedDomain", async () => {
    const user = userEvent.setup();
    const addItem = setCart([
      { domainName: "example.com", price: 999, currency: "INR", registrationPeriod: 1, itemType: "domain" },
    ]);
    render(<HostingUpsell />);
    await user.click(screen.getByRole("button", { name: /add hosting/i }));
    const item = addItem.mock.calls[0][0] as CartItem;
    expect(item.linkedDomain).toBe("example.com");
  });

  it("skips adding and shows an error toast when the same hosting plan is already in cart", async () => {
    const user = userEvent.setup();
    const addItem = setCart([
      {
        domainName: "hosting-standard-existing",
        price: HOSTING_PLANS.standard.price,
        currency: "INR",
        registrationPeriod: 12,
        itemType: "hosting",
        hostingPlan: { id: HOSTING_PLANS.standard.id, name: "Standard Hosting" },
      },
    ]);
    render(<HostingUpsell />);
    await user.click(screen.getByRole("button", { name: /add hosting/i }));
    expect(addItem).not.toHaveBeenCalled();
    expect(mockToast.error).toHaveBeenCalledWith(expect.stringMatching(/already in your cart/i));
  });

  it("treats a legacy domain item without itemType as a domain for auto-linking", async () => {
    // Legacy domain items have no itemType set (defaults to 'domain'); the
    // component's lookup uses `!item.itemType || item.itemType === 'domain'`.
    const user = userEvent.setup();
    const addItem = setCart([
      { domainName: "legacy.com", price: 999, currency: "INR", registrationPeriod: 1 } as CartItem,
    ]);
    render(<HostingUpsell />);
    await user.click(screen.getByRole("button", { name: /add hosting/i }));
    const item = addItem.mock.calls[0][0] as CartItem;
    expect(item.linkedDomain).toBe("legacy.com");
  });
});
