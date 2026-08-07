/**
 * Component tests for the user dashboard <UserLayout> (rescan-4 M14).
 * Pins:
 *  - 7-item nav (Dashboard / Domains / Hosting / My Services / Billing /
 *    Support / Account Settings) with active-link routing
 *  - Top-bar heading reflects the active nav item
 *  - User info block: name + email when user present; 'Loading...' when
 *    user=null OR isLoading=true
 *  - Logout button gating:
 *      * onLogout present + user → 'Logout' (active testid)
 *      * onLogout present + user=null → disabled 'Loading...'
 *      * onLogout absent → 'No logout handler' inactive testid
 *  - Logout click awaits the async onLogout callback
 *  - hideFloatingButtons hides the floating Home button
 *  - ProfileCompletionWarning is rendered (mocked)
 *  - isLoading=true swaps the children for the DataLoading skeleton
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

const pathnameMock = vi.hoisted(() => vi.fn(() => "/dashboard"));
vi.mock("next/navigation", () => ({ usePathname: pathnameMock }));

const itemCountMock = vi.hoisted(() => vi.fn(() => 0));
const subscribeMock = vi.hoisted(() => vi.fn((_cb: unknown) => () => {}));
vi.mock("@/store/cartStore", () => {
  const useCartStore = Object.assign(
    () => ({ getItemCount: itemCountMock }),
    { subscribe: subscribeMock }
  );
  return { useCartStore };
});

vi.mock("@/components/ProfileCompletionWarning", () => ({
  default: () => <div data-testid="profile-warning" />,
}));

vi.mock("@/components/user/LoadingComponents", () => ({
  DataLoading: ({ type, count }: { type: string; count: number }) => (
    <div data-testid="data-loading" data-type={type} data-count={count} />
  ),
}));

import UserLayout from "@/components/user/UserLayout";

const USER = { firstName: "Ada", lastName: "Lovelace", email: "ada@example.test" };

beforeEach(() => {
  pathnameMock.mockReturnValue("/dashboard");
  itemCountMock.mockReturnValue(0);
});

describe("<UserLayout>", () => {
  it("renders all 7 nav items", () => {
    render(
      <UserLayout user={USER}>
        <div data-testid="page" />
      </UserLayout>
    );
    // Anchored exact-match for most labels, but Billing uses RupeeIcon
    // (which renders ₹ as text content in its SVG) so the link's accessible
    // name is '₹Billing' — use a substring match for that one.
    for (const label of ["Dashboard", "Domains", "Hosting", "My Services", "Support", "Account Settings"]) {
      expect(
        screen.getByRole("link", { name: new RegExp(`^${label}$`, "i") })
      ).toBeInTheDocument();
    }
    expect(screen.getByRole("link", { name: /Billing/i })).toBeInTheDocument();
  });

  it("active link picks up the blue text + border classes", () => {
    pathnameMock.mockReturnValue("/dashboard/domains");
    render(
      <UserLayout user={USER}>
        <div />
      </UserLayout>
    );
    const domains = screen.getByRole("link", { name: /^domains$/i });
    expect(domains.className).toMatch(/text-blue-700/);
    expect(domains.className).toMatch(/border-blue-700/);
  });

  it("top-bar heading reflects the active nav item name", () => {
    pathnameMock.mockReturnValue("/dashboard/hosting");
    render(
      <UserLayout user={USER}>
        <div />
      </UserLayout>
    );
    expect(screen.getByRole("heading", { name: /^hosting$/i })).toBeInTheDocument();
  });

  it("top-bar heading falls back to 'Dashboard' when no nav matches", () => {
    pathnameMock.mockReturnValue("/some/unrelated/route");
    render(
      <UserLayout user={USER}>
        <div />
      </UserLayout>
    );
    expect(screen.getByRole("heading", { name: /^dashboard$/i })).toBeInTheDocument();
  });

  it("user-info block shows name + email when user present", () => {
    render(
      <UserLayout user={USER}>
        <div />
      </UserLayout>
    );
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("ada@example.test")).toBeInTheDocument();
  });

  it("user-info block shows 'Loading...' when user=null", () => {
    render(
      <UserLayout user={null}>
        <div />
      </UserLayout>
    );
    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(screen.getByText("Please wait")).toBeInTheDocument();
  });

  it("onLogout present + user present → active Logout button", () => {
    render(
      <UserLayout user={USER} onLogout={vi.fn()}>
        <div />
      </UserLayout>
    );
    const btn = screen.getByTestId("logout-button-active");
    expect(btn).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
  });

  it("onLogout present + user=null → disabled Logout button (loading copy)", () => {
    render(
      <UserLayout user={null} onLogout={vi.fn()}>
        <div />
      </UserLayout>
    );
    expect(screen.getByTestId("logout-button-disabled")).toBeDisabled();
  });

  it("onLogout absent → inactive 'No logout handler' block", () => {
    render(
      <UserLayout user={USER}>
        <div />
      </UserLayout>
    );
    expect(screen.getByTestId("logout-button-inactive")).toBeInTheDocument();
    expect(screen.getByText(/no logout handler/i)).toBeInTheDocument();
  });

  it("clicking the active Logout button calls onLogout", async () => {
    const user = userEvent.setup();
    const onLogout = vi.fn().mockResolvedValue(undefined);
    render(
      <UserLayout user={USER} onLogout={onLogout}>
        <div />
      </UserLayout>
    );
    await user.click(screen.getByTestId("logout-button-active"));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("renders the ProfileCompletionWarning", () => {
    render(
      <UserLayout user={USER}>
        <div />
      </UserLayout>
    );
    expect(screen.getByTestId("profile-warning")).toBeInTheDocument();
  });

  it("isLoading=true swaps children for the DataLoading skeleton", () => {
    render(
      <UserLayout user={USER} isLoading>
        <div data-testid="kid" />
      </UserLayout>
    );
    expect(screen.getByTestId("data-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("kid")).not.toBeInTheDocument();
  });

  it("hideFloatingButtons=true removes the floating Home link", () => {
    render(
      <UserLayout user={USER} hideFloatingButtons>
        <div />
      </UserLayout>
    );
    expect(screen.queryByTitle(/go back to homepage/i)).not.toBeInTheDocument();
  });

  it("default render includes the floating Home link", () => {
    render(
      <UserLayout user={USER}>
        <div />
      </UserLayout>
    );
    expect(screen.getByTitle(/go back to homepage/i)).toBeInTheDocument();
  });
});
