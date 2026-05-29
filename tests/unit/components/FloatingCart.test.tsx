/**
 * Component tests for <FloatingCart> (rescan-4 M14).
 * Pins the four hide gates:
 *  - SSR (isMounted=false) — covered indirectly via the mounted=true branch
 *  - User-is-admin (parsed from safeLocalStorage 'user' record)
 *  - On any /admin/* route
 *  - On dashboard invoice /view pages
 * Plus the cart-count badge: hidden at 0, shown otherwise, '9+' cap.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const pathnameMock = vi.hoisted(() => vi.fn(() => "/"));
vi.mock("next/navigation", () => ({
  usePathname: pathnameMock,
}));

const safeLocalStorageStore = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/storage", () => ({
  safeLocalStorage: {
    getItem: (k: string) => safeLocalStorageStore.get(k) ?? null,
    setItem: (k: string, v: string) => safeLocalStorageStore.set(k, v),
    removeItem: (k: string) => safeLocalStorageStore.delete(k),
  },
}));

const itemCountMock = vi.hoisted(() => vi.fn(() => 0));
const subscribeMock = vi.hoisted(() => vi.fn((_cb: unknown) => () => {}));
vi.mock("@/store/cartStore", () => {
  const useCartStore = Object.assign(
    () => ({ getItemCount: itemCountMock }),
    { subscribe: subscribeMock }
  );
  return { useCartStore };
});

import FloatingCart from "@/components/FloatingCart";

beforeEach(() => {
  pathnameMock.mockReturnValue("/");
  safeLocalStorageStore.clear();
  itemCountMock.mockReturnValue(0);
  subscribeMock.mockReset();
  subscribeMock.mockImplementation((_cb: unknown) => () => {});
});

describe("<FloatingCart>", () => {
  it("renders the cart link on a public route for a non-admin user", () => {
    render(<FloatingCart />);
    expect(screen.getByRole("link", { name: /view cart/i })).toBeInTheDocument();
  });

  it("shows the badge with the current item count when cart > 0", () => {
    itemCountMock.mockReturnValue(3);
    render(<FloatingCart />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("badge caps at '9+' once count exceeds 9", () => {
    itemCountMock.mockReturnValue(15);
    render(<FloatingCart />);
    expect(screen.getByText("9+")).toBeInTheDocument();
  });

  it("hides the badge when the cart is empty (no badge span rendered)", () => {
    itemCountMock.mockReturnValue(0);
    const { container } = render(<FloatingCart />);
    expect(container.querySelector("span.bg-red-500")).toBeNull();
  });

  it("renders nothing on /admin/* routes", () => {
    pathnameMock.mockReturnValue("/admin/users");
    render(<FloatingCart />);
    expect(screen.queryByRole("link", { name: /view cart/i })).not.toBeInTheDocument();
  });

  it("renders nothing when the localStorage user record marks role=admin", () => {
    safeLocalStorageStore.set("user", JSON.stringify({ role: "admin", email: "x@y" }));
    render(<FloatingCart />);
    expect(screen.queryByRole("link", { name: /view cart/i })).not.toBeInTheDocument();
  });

  it("renders nothing on /dashboard/invoices/.../view pages", () => {
    pathnameMock.mockReturnValue("/dashboard/invoices/123/view");
    render(<FloatingCart />);
    expect(screen.queryByRole("link", { name: /view cart/i })).not.toBeInTheDocument();
  });
});
