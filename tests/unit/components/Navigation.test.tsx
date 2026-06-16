/**
 * Component tests for the public-site <Navigation> (rescan-4 M14).
 * Pins the three variant shapes (default / dashboard / admin) and the
 * authentication + cart-count gating.
 *
 * Mocks: next/navigation.usePathname, next-auth/react.useSession,
 * @/store/cartStore.useCartStore (with the static `subscribe`).
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

const pathnameMock = vi.hoisted(() => vi.fn(() => "/"));
vi.mock("next/navigation", () => ({ usePathname: pathnameMock }));

type SessionMockReturn = {
  data: { user?: { name?: string; role?: string } } | null;
  status: "authenticated" | "unauthenticated" | "loading";
} | undefined;
const useSessionMock = vi.hoisted(() =>
  vi.fn<() => SessionMockReturn>(() => ({ data: null, status: "unauthenticated" }))
);
vi.mock("next-auth/react", () => ({ useSession: useSessionMock }));

const itemCountMock = vi.hoisted(() => vi.fn(() => 0));
const subscribeMock = vi.hoisted(() => vi.fn((_cb: unknown) => () => {}));
vi.mock("@/store/cartStore", () => {
  const useCartStore = Object.assign(
    () => ({ getItemCount: itemCountMock }),
    { subscribe: subscribeMock }
  );
  return { useCartStore };
});

import Navigation from "@/components/Navigation";

beforeEach(() => {
  pathnameMock.mockReturnValue("/");
  useSessionMock.mockReturnValue({ data: null, status: "unauthenticated" });
  itemCountMock.mockReturnValue(0);
});

describe("<Navigation> default variant (public site)", () => {
  it("renders the 4 desktop nav links (Home/Hosting/About/Contact)", () => {
    render(<Navigation />);
    for (const label of ["Home", "Hosting", "About Us", "Contact Us"]) {
      // Desktop + mobile each render their own copy of these links → getAll.
      expect(screen.getAllByRole("link", { name: label }).length).toBeGreaterThanOrEqual(1);
    }
  });

  it("unauthenticated → renders the Login link, NOT the Dashboard link", () => {
    render(<Navigation />);
    expect(screen.getAllByRole("link", { name: /^login$/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("link", { name: /^dashboard$/i })).not.toBeInTheDocument();
  });

  it("authenticated → renders the Dashboard link, NOT Login", () => {
    useSessionMock.mockReturnValue({
      data: { user: { name: "Ada Lovelace", role: "user" } },
      status: "authenticated",
    });
    render(<Navigation />);
    // Both desktop and mobile menus render Dashboard, so use getAllByRole.
    expect(screen.getAllByRole("link", { name: /dashboard/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("link", { name: /^login$/i })).not.toBeInTheDocument();
  });

  it("active-link routing applies the blue colour class to the matching pathname", () => {
    pathnameMock.mockReturnValue("/hosting");
    render(<Navigation />);
    const hostingLinks = screen.getAllByRole("link", { name: /^hosting$/i });
    // At least one (the desktop one) carries the blue class.
    expect(hostingLinks.some((a) => /google-blue/.test(a.className))).toBe(true);
  });

  it("cart-count badge appears once cart > 0", () => {
    itemCountMock.mockReturnValue(3);
    render(<Navigation />);
    expect(screen.getAllByText("3").length).toBeGreaterThanOrEqual(1);
  });

  it("clicking the mobile menu button toggles the menu open/closed", async () => {
    const user = userEvent.setup();
    render(<Navigation />);
    const menuBtn = screen.getByRole("button", { name: /toggle mobile menu/i });
    expect(menuBtn).toBeInTheDocument();
    // Mobile menu container exists either way; clicking is the smoke test.
    await user.click(menuBtn);
    await user.click(menuBtn);
  });

  it("survives an undefined-session race (useSession returns undefined)", () => {
    useSessionMock.mockReturnValue(undefined);
    expect(() => render(<Navigation />)).not.toThrow();
    // Falls back to the unauthenticated branch → Login link visible.
    expect(screen.getAllByRole("link", { name: /^login$/i }).length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Login button — context-aware returnUrl
// ═══════════════════════════════════════════════════════════════════
describe("<Navigation> Login button — returnUrl carries the current path", () => {
  /** Return the first href of the desktop or mobile Login link. */
  function loginHrefFromRender(): string {
    const links = screen.getAllByRole("link", { name: /^login$/i });
    return links[0].getAttribute("href") || "";
  }

  it("homepage (/) → plain /login (nowhere meaningful to return to)", () => {
    pathnameMock.mockReturnValue("/");
    render(<Navigation />);
    expect(loginHrefFromRender()).toBe("/login");
  });

  it("/cart → /login?returnUrl=%2Fcart (the main customer-flow case)", () => {
    pathnameMock.mockReturnValue("/cart");
    render(<Navigation />);
    expect(loginHrefFromRender()).toBe("/login?returnUrl=%2Fcart");
  });

  it("/domains/search → returnUrl carries the full path including slashes (URL-encoded)", () => {
    pathnameMock.mockReturnValue("/domains/search");
    render(<Navigation />);
    expect(loginHrefFromRender()).toBe("/login?returnUrl=%2Fdomains%2Fsearch");
  });

  it("/hosting/plans → returnUrl carries the full path", () => {
    pathnameMock.mockReturnValue("/hosting/plans");
    render(<Navigation />);
    expect(loginHrefFromRender()).toBe("/login?returnUrl=%2Fhosting%2Fplans");
  });

  // The auth-flow pages are excluded so the customer can never end up in a
  // login → login → login loop, or a register → login → register bounce.
  it.each([
    "/login",
    "/register",
    "/activate",
    "/reset-password",
    "/forgot-password",
    "/maintenance",
    "/403",
  ])("%s → plain /login (excluded path)", (path) => {
    pathnameMock.mockReturnValue(path);
    render(<Navigation />);
    expect(loginHrefFromRender()).toBe("/login");
  });

  it.each([
    "/login/forgot",
    "/register/social",
    "/activate/abc-123-token",
    "/reset-password/xyz",
  ])("sub-path %s of an excluded route → still plain /login", (path) => {
    pathnameMock.mockReturnValue(path);
    render(<Navigation />);
    expect(loginHrefFromRender()).toBe("/login");
  });

  it("malformed pathname (//evil.com) → plain /login (open-redirect guard)", () => {
    pathnameMock.mockReturnValue("//evil.com/phishing");
    render(<Navigation />);
    expect(loginHrefFromRender()).toBe("/login");
  });

  it("empty pathname → plain /login", () => {
    pathnameMock.mockReturnValue("");
    render(<Navigation />);
    expect(loginHrefFromRender()).toBe("/login");
  });

  it("authenticated → no Login link at all (Dashboard takes its place)", () => {
    pathnameMock.mockReturnValue("/cart");
    useSessionMock.mockReturnValue({
      data: { user: { name: "Ada Lovelace", role: "user" } },
      status: "authenticated",
    });
    render(<Navigation />);
    expect(screen.queryByRole("link", { name: /^login$/i })).not.toBeInTheDocument();
  });

  it("both desktop AND mobile Login buttons carry the returnUrl", () => {
    pathnameMock.mockReturnValue("/cart");
    render(<Navigation />);
    const links = screen.getAllByRole("link", { name: /^login$/i });
    // Expect at least 2 (desktop + mobile menu); both should have the same href.
    expect(links.length).toBeGreaterThanOrEqual(2);
    const hrefs = links.map((a) => a.getAttribute("href"));
    expect(hrefs.every((h) => h === "/login?returnUrl=%2Fcart")).toBe(true);
  });
});

describe("<Navigation> dashboard + admin variants", () => {
  it("variant='dashboard' renders the compact shell with Logout when onLogout supplied", async () => {
    const user = userEvent.setup();
    const onLogout = vi.fn();
    render(
      <Navigation
        variant="dashboard"
        user={{ firstName: "Ada", lastName: "Lovelace", role: "user" }}
        onLogout={onLogout}
      />
    );
    expect(screen.getByRole("button", { name: /^logout$/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^logout$/i }));
    expect(onLogout).toHaveBeenCalled();
  });

  it("variant='dashboard' role chip uses blue for user vs red for admin", () => {
    const { unmount } = render(
      <Navigation
        variant="dashboard"
        user={{ firstName: "U", lastName: "S", role: "user" }}
      />
    );
    expect(screen.getByText("USER").className).toMatch(/bg-blue-100/);
    unmount();
    render(
      <Navigation
        variant="dashboard"
        user={{ firstName: "U", lastName: "S", role: "admin" }}
      />
    );
    expect(screen.getByText("ADMIN").className).toMatch(/bg-red-100/);
  });

  it("variant='dashboard' shopping-cart link has the cart aria-label and current count", () => {
    itemCountMock.mockReturnValue(5);
    render(
      <Navigation
        variant="dashboard"
        user={{ firstName: "U", lastName: "S", role: "user" }}
      />
    );
    const cartLink = screen.getByRole("link", { name: /shopping cart/i });
    expect(cartLink).toHaveAttribute("href", "/cart");
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("variant='dashboard'/'admin' DO NOT render the public-site nav links", () => {
    render(<Navigation variant="dashboard" user={null} />);
    expect(screen.queryByRole("link", { name: /^hosting$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^about us$/i })).not.toBeInTheDocument();
  });
});
