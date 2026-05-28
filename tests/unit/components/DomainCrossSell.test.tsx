/**
 * Component tests for <DomainCrossSell> (rescan-4 M14).
 * The component is the cart-empty cross-sell card that lets a user search a
 * domain and add it to the cart. Tests cover the disabled-when-empty submit,
 * the no-dot auto-append (".com" default), the search-success + available
 * panel + Add button, the search-success + unavailable panel (no Add), the
 * apiClient failure → error toast + no panel, the exact-match preference
 * when the results list returns multiple entries, the typing-clears-result
 * behaviour, and the add-to-cart CartItem shape on the success path.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { CartItem } from "@/lib/types";

const { mockApiPost, mockAddItem, mockUseCartStore, mockToast } = vi.hoisted(() => {
  const toast = vi.fn() as unknown as ((...args: unknown[]) => unknown) & {
    error: ReturnType<typeof vi.fn>;
    success: ReturnType<typeof vi.fn>;
  };
  toast.error = vi.fn();
  toast.success = vi.fn();
  const addItem = vi.fn();
  return {
    mockApiPost: vi.fn(),
    mockAddItem: addItem,
    mockUseCartStore: vi.fn(() => ({ addItem })),
    mockToast: toast,
  };
});

vi.mock("@/lib/api-client", () => ({ apiClient: { post: mockApiPost } }));
vi.mock("@/store/cartStore", () => ({ useCartStore: mockUseCartStore }));
vi.mock("react-hot-toast", () => ({ default: mockToast, toast: mockToast }));

import DomainCrossSell from "@/components/DomainCrossSell";

beforeEach(() => {
  mockApiPost.mockReset();
  mockAddItem.mockClear();
  mockToast.error.mockClear();
  mockToast.success.mockClear();
});

describe("<DomainCrossSell>", () => {
  it("renders header copy + a disabled Search button when the input is empty", () => {
    render(<DomainCrossSell />);
    expect(screen.getByRole("heading", { name: /every website needs a domain/i })).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /search/i });
    expect(btn).toBeDisabled();
  });

  it("auto-appends '.com' when the query has no dot, then renders the available panel + Add button", async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue({
      ok: true,
      data: {
        success: true,
        results: [{ domainName: "example.com", available: true, price: 999, currency: "INR", registrationPeriod: 12 }],
      },
    });
    render(<DomainCrossSell />);
    await user.type(screen.getByPlaceholderText(/search domain/i), "example");
    await user.click(screen.getByRole("button", { name: /search/i }));

    // The auto-appended search term reaches apiClient
    expect(mockApiPost).toHaveBeenCalledWith("/api/v1/domains/search", { domain: "example.com" });
    expect(await screen.findByText("example.com")).toBeInTheDocument();
    expect(screen.getByText(/available/i)).toBeInTheDocument();
    expect(screen.getByText("₹999")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^add$/i })).toBeInTheDocument();
  });

  it("renders the taken/unavailable panel without the Add button when the API says success but the domain is taken", async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue({
      ok: true,
      data: { success: true, results: [{ domainName: "taken.com", available: false }] },
    });
    render(<DomainCrossSell />);
    await user.type(screen.getByPlaceholderText(/search domain/i), "taken.com");
    await user.click(screen.getByRole("button", { name: /search/i }));

    expect(await screen.findByText(/domain is taken or unavailable/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^add$/i })).not.toBeInTheDocument();
  });

  it("renders the unavailable panel when success:false with an error message", async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue({
      ok: true,
      data: { success: false, error: "Restricted TLD" },
    });
    render(<DomainCrossSell />);
    await user.type(screen.getByPlaceholderText(/search domain/i), "weird.xyz");
    await user.click(screen.getByRole("button", { name: /search/i }));

    expect(await screen.findByText("weird.xyz")).toBeInTheDocument();
    expect(screen.getByText(/domain is taken or unavailable/i)).toBeInTheDocument();
  });

  it("shows a toast.error and renders no panel when the apiClient call fails", async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue({ ok: false, error: { status: 0, message: "Network error" } });
    render(<DomainCrossSell />);
    await user.type(screen.getByPlaceholderText(/search domain/i), "x.com");
    await user.click(screen.getByRole("button", { name: /search/i }));

    await vi.waitFor(() => expect(mockToast.error).toHaveBeenCalledWith(expect.stringMatching(/failed to search/i)));
    expect(screen.queryByText(/available/i)).not.toBeInTheDocument();
  });

  it("prefers the exact-match result when the API returns several entries", async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue({
      ok: true,
      data: {
        success: true,
        results: [
          { domainName: "myproject.in", available: false },
          { domainName: "myproject.com", available: true, price: 799 },
        ],
      },
    });
    render(<DomainCrossSell />);
    await user.type(screen.getByPlaceholderText(/search domain/i), "myproject.com");
    await user.click(screen.getByRole("button", { name: /search/i }));

    // Exact-match preference picks the .com (available) entry, not the first one (.in, taken)
    expect(await screen.findByText("myproject.com")).toBeInTheDocument();
    expect(screen.getByText(/available/i)).toBeInTheDocument();
  });

  it("clears the previous result as soon as the user starts typing again", async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue({
      ok: true,
      data: { success: true, results: [{ domainName: "ok.com", available: true, price: 500 }] },
    });
    render(<DomainCrossSell />);
    const input = screen.getByPlaceholderText(/search domain/i);
    await user.type(input, "ok.com");
    await user.click(screen.getByRole("button", { name: /search/i }));
    expect(await screen.findByText("ok.com")).toBeInTheDocument();

    await user.type(input, "x");
    // onChange clears `result`, so the panel disappears
    expect(screen.queryByText("ok.com")).not.toBeInTheDocument();
  });

  it("Add button calls addItem with the correct domain CartItem shape and shows a success toast", async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue({
      ok: true,
      data: {
        success: true,
        results: [{ domainName: "buy.me", available: true, price: 1499, currency: "INR" }],
      },
    });
    render(<DomainCrossSell />);
    await user.type(screen.getByPlaceholderText(/search domain/i), "buy.me");
    await user.click(screen.getByRole("button", { name: /search/i }));
    await user.click(await screen.findByRole("button", { name: /^add$/i }));

    expect(mockAddItem).toHaveBeenCalledTimes(1);
    const item = mockAddItem.mock.calls[0][0] as CartItem;
    expect(item).toMatchObject({
      domainName: "buy.me",
      price: 1499,
      currency: "INR",
      registrationPeriod: 12,
      itemType: "domain",
    });
    expect(mockToast.success).toHaveBeenCalledWith(expect.stringMatching(/added to cart/i));
  });
});
