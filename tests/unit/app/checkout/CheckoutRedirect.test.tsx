/**
 * Component tests for the checkout page's redirect gating (rescan-4 M14 —
 * the explicit deferred "checkout useEffect redirect logic" item).
 *
 * The page has two redirect useEffects:
 *   1. After NextAuth resolves, hit `/auth/me`; admins → /admin/dashboard,
 *      non-admins without a completed profile → toast + /cart, fetch failure
 *      or thrown fetch → /login, completed profile → stay (setUser).
 *   2. Once the cart finishes loading, if items are empty and the user is
 *      set and no payment is in progress, replace to /dashboard.
 *
 * The page pulls in many unrelated subcomponents/hooks (Navigation, Footer,
 * Razorpay, OrderTimeline, ClientOnly, logger, storage…) — they're all
 * stubbed to keep the focus on the redirect paths.
 */
import { render, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReactNode } from "react";

const { mockRouter, mockUseSession, mockUseCartStore, mockToast, mockFetch } = vi.hoisted(() => {
  const toast = vi.fn() as unknown as ((...args: unknown[]) => unknown) & {
    error: ReturnType<typeof vi.fn>;
    success: ReturnType<typeof vi.fn>;
    loading: ReturnType<typeof vi.fn>;
    dismiss: ReturnType<typeof vi.fn>;
  };
  toast.error = vi.fn();
  toast.success = vi.fn();
  toast.loading = vi.fn();
  toast.dismiss = vi.fn();
  return {
    mockRouter: { push: vi.fn(), replace: vi.fn() },
    mockUseSession: vi.fn(),
    mockUseCartStore: vi.fn(),
    mockToast: toast,
    mockFetch: vi.fn(),
  };
});

vi.mock("next/navigation", () => ({ useRouter: () => mockRouter }));
vi.mock("next-auth/react", () => ({ useSession: mockUseSession }));
vi.mock("@/store/cartStore", () => ({ useCartStore: mockUseCartStore }));
vi.mock("react-hot-toast", () => ({ default: mockToast, toast: mockToast }));
vi.mock("@/lib/logout", () => ({ useLogout: () => vi.fn() }));
// The page fires trackInitiateCheckout() (Pixel + internal analytics fetch) once
// on mount, independent of the redirect logic under test — stub it so it doesn't
// pollute the fetch spy these tests assert on.
vi.mock("@/lib/journey", () => ({ trackInitiateCheckout: vi.fn() }));
vi.mock("@/lib/storage", () => ({
  safeSessionStorage: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
  safeLocalStorage: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));
vi.mock("@/lib/device-fingerprint", () => ({ getDeviceFingerprint: vi.fn(async () => "fp") }));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), log: vi.fn() },
}));
vi.mock("@/components/Navigation", () => ({ default: () => null }));
vi.mock("@/components/Footer", () => ({ default: () => null }));
vi.mock("@/components/checkout/OrderTimeline", () => ({ default: () => null }));
vi.mock("@/components/skeletons/PageSkeletons", () => ({ CheckoutPageSkeleton: () => null }));
vi.mock("@/components/ClientOnly", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/components/RazorpayCheckoutFrame", () => ({
  useRazorpayCheckout: () => ({ open: vi.fn(), Frame: () => null }),
}));

// Stub global fetch — assigned a Response-shaped object per test.
global.fetch = mockFetch as unknown as typeof fetch;

import CheckoutPage from "@/app/checkout/page";

function defaultCartStore() {
  return {
    items: [{ domainName: "example.com", price: 999, currency: "INR", registrationPeriod: 1, itemType: "domain" as const }],
    getTotalPrice: () => 1180,
    getSubtotalPrice: () => 1000,
    getItemCount: () => 1,
    clearCart: vi.fn(),
    syncWithServer: vi.fn().mockResolvedValue(undefined),
    isLoading: false,
    hasDomainItems: () => true,
    hasHostingItems: () => false,
  };
}
type CartStoreState = ReturnType<typeof defaultCartStore>;
function buildCartStore(overrides: Partial<CartStoreState> = {}): CartStoreState {
  return { ...defaultCartStore(), ...overrides };
}

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  };
}

beforeEach(() => {
  mockRouter.push.mockClear();
  mockRouter.replace.mockClear();
  mockToast.error.mockClear();
  mockFetch.mockReset();
  mockUseSession.mockReturnValue({
    data: {
      user: { id: "u1", name: "Jane Doe", email: "jane@example.com", role: "user", profileCompleted: true },
    },
    status: "authenticated",
  });
  mockUseCartStore.mockReturnValue(buildCartStore());
});

describe("CheckoutPage redirect gating (first useEffect)", () => {
  it("does nothing while NextAuth status is 'loading'", async () => {
    mockUseSession.mockReturnValue({ data: null, status: "loading" });
    render(<CheckoutPage />);
    // Give microtasks a tick — the effect should bail before fetch
    await new Promise((r) => setTimeout(r, 10));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it("routes admin users to /admin/dashboard", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ user: { role: "admin", profileCompleted: true } }));
    render(<CheckoutPage />);
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith("/admin/dashboard"));
  });

  it("routes users without a completed profile back to /cart with a toast", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ user: { role: "user", profileCompleted: false } }));
    render(<CheckoutPage />);
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith("/cart"));
    expect(mockToast.error).toHaveBeenCalledWith(expect.stringMatching(/complete your profile/i));
  });

  it("treats a non-boolean-true profileCompleted as incomplete (strict check)", async () => {
    // The page coerces profileCompleted with `=== true`, so the string "true"
    // does NOT pass the gate — pinning that semantics here.
    mockFetch.mockResolvedValue(jsonResponse({ user: { role: "user", profileCompleted: "true" } }));
    render(<CheckoutPage />);
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith("/cart"));
  });

  it("routes to /login when /auth/me returns non-ok", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: "unauthorized" }, { ok: false, status: 401 }));
    render(<CheckoutPage />);
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith("/login"));
  });

  it("routes to /login when the /auth/me fetch throws", async () => {
    mockFetch.mockRejectedValue(new Error("network down"));
    render(<CheckoutPage />);
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith("/login"));
  });

  it("stays on the page (no redirect) for an authenticated user with a completed profile", async () => {
    const store = buildCartStore();
    mockUseCartStore.mockReturnValue(store);
    // Checkout now also requires a WhatsApp number — supply one so the user
    // passes the gate and stays on the page.
    mockFetch.mockResolvedValue(
      jsonResponse({ user: { role: "user", profileCompleted: true, whatsappNumber: "+919876543210" } })
    );
    render(<CheckoutPage />);
    await waitFor(() => expect(store.syncWithServer).toHaveBeenCalled());
    expect(mockRouter.push).not.toHaveBeenCalled();
  });
});

describe("CheckoutPage empty-cart redirect (second useEffect)", () => {
  it("replaces to /dashboard once the user is set and the cart is empty", async () => {
    mockUseCartStore.mockReturnValue(
      buildCartStore({ items: [], isLoading: false, getItemCount: () => 0 })
    );
    // User must clear the profile + WhatsApp gates for `user` to be set, which
    // the empty-cart effect depends on before it replaces to /dashboard.
    mockFetch.mockResolvedValue(
      jsonResponse({ user: { role: "user", profileCompleted: true, whatsappNumber: "+919876543210" } })
    );
    render(<CheckoutPage />);
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith("/dashboard"));
  });

  it("does NOT replace while the cart is still loading", async () => {
    mockUseCartStore.mockReturnValue(
      buildCartStore({ items: [], isLoading: true, getItemCount: () => 0 })
    );
    mockFetch.mockResolvedValue(jsonResponse({ user: { role: "user", profileCompleted: true } }));
    render(<CheckoutPage />);
    await new Promise((r) => setTimeout(r, 20));
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });
});
