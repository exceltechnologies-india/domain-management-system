/**
 * Component tests for <DomainSelectionModal> (rescan-4 M14).
 * Shown when a user picks a hosting plan and must associate a domain
 * with it. Heavy mock setup:
 *  - `@/store/cartStore` — addItem / updateItem / items
 *  - `react-hot-toast` — toast.success / toast.error
 *
 * Pins:
 *  - isOpen gate
 *  - Empty input → 'Please enter a domain name' error
 *  - Invalid format → 'Please enter a valid domain name' error
 *  - Existing placeholder item → updateItem flow (domainName replaced)
 *  - New cart flow → addItem with the correct hostingItem shape
 *  - onSuccess(newDomain) + onClose both fire on success
 *  - existingDomainName=hosting-* placeholder → input starts empty
 *  - existingDomainName=user-supplied → input pre-fills
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

const addItemMock = vi.hoisted(() => vi.fn());
const updateItemMock = vi.hoisted(() => vi.fn());
const removeItemMock = vi.hoisted(() => vi.fn());
const itemsRef = vi.hoisted(
  () => ({ current: [] as Array<{ itemType: string; domainName: string }> })
);
vi.mock("@/store/cartStore", () => ({
  useCartStore: () => ({
    addItem: addItemMock,
    removeItem: removeItemMock,
    updateItem: updateItemMock,
    items: itemsRef.current,
  }),
}));

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock("react-hot-toast", () => ({
  default: { success: toastSuccess, error: toastError },
  __esModule: true,
}));

import DomainSelectionModal from "@/components/DomainSelectionModal";

const PLAN = {
  id: "biz",
  name: "Business",
  price: 999,
  features: ["10 GB", "100 GB BW"],
};

beforeEach(() => {
  addItemMock.mockReset();
  updateItemMock.mockReset();
  removeItemMock.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  itemsRef.current = [];
});

describe("<DomainSelectionModal>", () => {
  it("isOpen=false renders nothing", () => {
    render(
      <DomainSelectionModal isOpen={false} onClose={vi.fn()} plan={PLAN} />
    );
    expect(screen.queryByText(/setup your hosting/i)).not.toBeInTheDocument();
  });

  it("empty input → 'Please enter a domain name' error", async () => {
    const user = userEvent.setup();
    render(<DomainSelectionModal isOpen onClose={vi.fn()} plan={PLAN} />);
    await user.click(screen.getByRole("button", { name: /continue to checkout/i }));
    expect(screen.getByText(/please enter a domain name/i)).toBeInTheDocument();
    expect(addItemMock).not.toHaveBeenCalled();
  });

  it("invalid format → 'Please enter a valid domain name' error", async () => {
    const user = userEvent.setup();
    render(<DomainSelectionModal isOpen onClose={vi.fn()} plan={PLAN} />);
    const input = screen.getByPlaceholderText("example.com");
    await user.type(input, "not-a-domain");
    await user.click(screen.getByRole("button", { name: /continue to checkout/i }));
    expect(screen.getByText(/please enter a valid domain name/i)).toBeInTheDocument();
    expect(addItemMock).not.toHaveBeenCalled();
  });

  it("valid domain + no existingDomainName → addItem with 12-month period + lowercased domain", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSuccess = vi.fn();
    render(
      <DomainSelectionModal isOpen onClose={onClose} plan={PLAN} onSuccess={onSuccess} />
    );
    await user.type(screen.getByPlaceholderText("example.com"), "MySite.com");
    await user.click(screen.getByRole("button", { name: /continue to checkout/i }));
    expect(addItemMock).toHaveBeenCalledWith({
      domainName: "mysite.com",
      price: 999,
      currency: "INR",
      registrationPeriod: 12,
      itemType: "hosting",
      hostingPlan: { name: "Business", period: 12, features: ["10 GB", "100 GB BW"] },
    });
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/Business for mysite\.com/));
    expect(onSuccess).toHaveBeenCalledWith("mysite.com");
    expect(onClose).toHaveBeenCalled();
  });

  it("existingDomainName='hosting-abc' placeholder → input starts empty (cleared on open)", () => {
    render(
      <DomainSelectionModal
        isOpen
        onClose={vi.fn()}
        plan={PLAN}
        existingDomainName="hosting-abc"
      />
    );
    expect((screen.getByPlaceholderText("example.com") as HTMLInputElement).value).toBe("");
  });

  it("existingDomainName='oldsite.com' → input pre-fills with the existing value", () => {
    render(
      <DomainSelectionModal
        isOpen
        onClose={vi.fn()}
        plan={PLAN}
        existingDomainName="oldsite.com"
      />
    );
    expect((screen.getByPlaceholderText("example.com") as HTMLInputElement).value).toBe(
      "oldsite.com"
    );
  });

  it("existingDomainName + matching cart item → updateItem (not addItem) with the new domain", async () => {
    const user = userEvent.setup();
    itemsRef.current = [
      { itemType: "hosting", domainName: "oldsite.com" } as unknown as {
        itemType: string;
        domainName: string;
      },
    ];
    render(
      <DomainSelectionModal
        isOpen
        onClose={vi.fn()}
        plan={PLAN}
        existingDomainName="oldsite.com"
      />
    );
    const input = screen.getByPlaceholderText("example.com");
    await user.clear(input);
    await user.type(input, "newsite.com");
    await user.click(screen.getByRole("button", { name: /continue to checkout/i }));
    expect(updateItemMock).toHaveBeenCalledWith(
      "oldsite.com",
      expect.objectContaining({ domainName: "newsite.com", itemType: "hosting" })
    );
    expect(addItemMock).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/Business updated for newsite\.com/));
  });

  it("typing after an error clears the error message", async () => {
    const user = userEvent.setup();
    render(<DomainSelectionModal isOpen onClose={vi.fn()} plan={PLAN} />);
    await user.click(screen.getByRole("button", { name: /continue to checkout/i }));
    expect(screen.getByText(/please enter a domain name/i)).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("example.com"), "m");
    expect(screen.queryByText(/please enter a domain name/i)).not.toBeInTheDocument();
  });
});
