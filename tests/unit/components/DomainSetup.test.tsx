/**
 * Component tests for <DomainSetup> (rescan-4 M14).
 * The component is the "Connect a Domain" card shown on the cart page for
 * unattached hosting items (those whose `domainName` starts with `hosting-`
 * and have no `linkedDomain`). Two tabs:
 *   - Link Existing: validate + link an existing domain. Empty / malformed
 *     input shows inline errors; valid input fires `onUpdateDomain` after a
 *     500ms delay along with a success toast.
 *   - Buy New: search via apiClient (same .com auto-append, exact-match
 *     preference and result-panel shapes as <DomainCrossSell>). The Add &
 *     Link button on an available result fires `onAddDomainToCart` for the
 *     new domain CartItem (period 1) AND `onUpdateDomain` to link it to the
 *     hosting placeholder, then clears the search state.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { CartItem } from "@/lib/types";

const { mockApiPost, mockToast } = vi.hoisted(() => {
  const toast = vi.fn() as unknown as ((...args: unknown[]) => unknown) & {
    error: ReturnType<typeof vi.fn>;
    success: ReturnType<typeof vi.fn>;
  };
  toast.error = vi.fn();
  toast.success = vi.fn();
  return {
    mockApiPost: vi.fn(),
    mockToast: toast,
  };
});

vi.mock("@/lib/api-client", () => ({ apiClient: { post: mockApiPost } }));
vi.mock("react-hot-toast", () => ({ default: mockToast, toast: mockToast }));

import DomainSetup from "@/components/DomainSetup";

const hostingPlaceholder: CartItem = {
  domainName: "hosting-standard-1234",
  price: 250,
  currency: "INR",
  registrationPeriod: 12,
  itemType: "hosting",
  hostingPlan: { name: "Starter Hosting" },
};

function renderSetup() {
  const onUpdateDomain = vi.fn();
  const onAddDomainToCart = vi.fn();
  render(
    <DomainSetup
      hostingItem={hostingPlaceholder}
      onUpdateDomain={onUpdateDomain}
      onAddDomainToCart={onAddDomainToCart}
    />
  );
  return { onUpdateDomain, onAddDomainToCart };
}

beforeEach(() => {
  mockApiPost.mockReset();
  mockToast.error.mockClear();
  mockToast.success.mockClear();
});

describe("<DomainSetup>", () => {
  it("renders the heading with the hosting plan name and defaults to the Link tab", () => {
    renderSetup();
    expect(screen.getByRole("heading", { name: /connect a domain/i })).toBeInTheDocument();
    expect(screen.getByText(/starter hosting/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("example.com")).toBeInTheDocument();
  });

  it("falls back to 'Hosting Plan' when the hosting item has no plan name", () => {
    const onUpdateDomain = vi.fn();
    const onAddDomainToCart = vi.fn();
    render(
      <DomainSetup
        hostingItem={{ ...hostingPlaceholder, hostingPlan: undefined }}
        onUpdateDomain={onUpdateDomain}
        onAddDomainToCart={onAddDomainToCart}
      />
    );
    expect(screen.getByText(/hosting plan/i)).toBeInTheDocument();
  });

  describe("Link Existing tab", () => {
    it("shows 'Required' when the input is empty and the user clicks Link Domain", async () => {
      const user = userEvent.setup();
      const { onUpdateDomain } = renderSetup();
      await user.click(screen.getByRole("button", { name: /link domain/i }));
      expect(screen.getByText("Required")).toBeInTheDocument();
      expect(onUpdateDomain).not.toHaveBeenCalled();
    });

    it("shows 'Invalid domain format' for a malformed input", async () => {
      const user = userEvent.setup();
      const { onUpdateDomain } = renderSetup();
      await user.type(screen.getByPlaceholderText("example.com"), "not-a-domain");
      await user.click(screen.getByRole("button", { name: /link domain/i }));
      expect(screen.getByText(/invalid domain format/i)).toBeInTheDocument();
      expect(onUpdateDomain).not.toHaveBeenCalled();
    });

    it("clears the inline error as soon as the user types again", async () => {
      const user = userEvent.setup();
      renderSetup();
      await user.click(screen.getByRole("button", { name: /link domain/i }));
      expect(screen.getByText("Required")).toBeInTheDocument();
      await user.type(screen.getByPlaceholderText("example.com"), "e");
      expect(screen.queryByText("Required")).not.toBeInTheDocument();
    });

    it("calls onUpdateDomain with (placeholder, newDomain) after the 500ms delay and toasts success", async () => {
      const user = userEvent.setup();
      const { onUpdateDomain } = renderSetup();
      await user.type(screen.getByPlaceholderText("example.com"), "example.com");
      await user.click(screen.getByRole("button", { name: /link domain/i }));
      await waitFor(
        () => expect(onUpdateDomain).toHaveBeenCalledWith("hosting-standard-1234", "example.com"),
        { timeout: 1000 }
      );
      expect(mockToast.success).toHaveBeenCalledWith(expect.stringMatching(/linked successfully/i));
    });
  });

  describe("Buy New tab", () => {
    async function switchToBuyTab(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByRole("button", { name: /buy new/i }));
    }

    it("switches to the search UI when the Buy New tab is clicked", async () => {
      const user = userEvent.setup();
      renderSetup();
      await switchToBuyTab(user);
      expect(screen.getByPlaceholderText(/find your perfect domain/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /check availability/i })).toBeInTheDocument();
    });

    it("auto-appends .com when the search has no dot and renders the available panel", async () => {
      const user = userEvent.setup();
      mockApiPost.mockResolvedValue({
        ok: true,
        data: {
          success: true,
          results: [{ domainName: "myproject.com", available: true, price: 799, currency: "INR" }],
        },
      });
      renderSetup();
      await switchToBuyTab(user);
      await user.type(screen.getByPlaceholderText(/find your perfect domain/i), "myproject");
      await user.click(screen.getByRole("button", { name: /check availability/i }));

      expect(mockApiPost).toHaveBeenCalledWith("/api/v1/domains/search", { domain: "myproject.com" });
      expect(await screen.findByText("myproject.com")).toBeInTheDocument();
      expect(screen.getByText("Available")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /add & link/i })).toBeInTheDocument();
    });

    it("renders the unavailable panel without Add & Link when the domain is taken", async () => {
      const user = userEvent.setup();
      mockApiPost.mockResolvedValue({
        ok: true,
        data: { success: true, results: [{ domainName: "taken.com", available: false }] },
      });
      renderSetup();
      await switchToBuyTab(user);
      await user.type(screen.getByPlaceholderText(/find your perfect domain/i), "taken.com");
      await user.click(screen.getByRole("button", { name: /check availability/i }));

      expect(await screen.findByText(/unavailable/i)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /add & link/i })).not.toBeInTheDocument();
    });

    it("toasts an error when apiClient fails", async () => {
      const user = userEvent.setup();
      mockApiPost.mockResolvedValue({ ok: false, error: { status: 0, message: "Network error" } });
      renderSetup();
      await switchToBuyTab(user);
      await user.type(screen.getByPlaceholderText(/find your perfect domain/i), "x.com");
      await user.click(screen.getByRole("button", { name: /check availability/i }));

      await vi.waitFor(() => expect(mockToast.error).toHaveBeenCalledWith(expect.stringMatching(/failed to search/i)));
    });

    it("Add & Link fires both onAddDomainToCart (period 1) and onUpdateDomain, then clears the search state", async () => {
      const user = userEvent.setup();
      mockApiPost.mockResolvedValue({
        ok: true,
        data: {
          success: true,
          results: [{ domainName: "buy.me", available: true, price: 1499, currency: "INR" }],
        },
      });
      const { onUpdateDomain, onAddDomainToCart } = renderSetup();
      await switchToBuyTab(user);
      await user.type(screen.getByPlaceholderText(/find your perfect domain/i), "buy.me");
      await user.click(screen.getByRole("button", { name: /check availability/i }));
      await user.click(await screen.findByRole("button", { name: /add & link/i }));

      expect(onAddDomainToCart).toHaveBeenCalledTimes(1);
      const item = onAddDomainToCart.mock.calls[0][0] as CartItem;
      expect(item).toMatchObject({
        domainName: "buy.me",
        price: 1499,
        currency: "INR",
        registrationPeriod: 1, // Note: domain default here is 1 year, not 12 like the upsell
        itemType: "domain",
      });
      expect(onUpdateDomain).toHaveBeenCalledWith("hosting-standard-1234", "buy.me");
      expect(mockToast.success).toHaveBeenCalledWith(expect.stringMatching(/added and linked/i));

      // Search state cleared — input emptied and panel gone
      expect(screen.queryByText("buy.me")).not.toBeInTheDocument();
      expect((screen.getByPlaceholderText(/find your perfect domain/i) as HTMLInputElement).value).toBe("");
    });
  });
});
