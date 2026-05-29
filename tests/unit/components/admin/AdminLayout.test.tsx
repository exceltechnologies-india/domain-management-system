/**
 * Component tests for the admin <AdminLayout> (rescan-4 M14).
 * Distinct from `skeletons/AdminLayout` (the loading-state shell covered
 * in 7cl). Pins the 11-item nav, the children render slot, the **active-
 * link routing** (incl. the two special cases: `/admin` → Dashboard
 * active, `/admin/dns-management` → Domains active), the mobile sidebar
 * toggle, and the optional Logout button + the user-initials display.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

const pathnameMock = vi.hoisted(() => vi.fn(() => "/"));
vi.mock("next/navigation", () => ({ usePathname: pathnameMock }));

import AdminLayout from "@/components/admin/AdminLayout";

beforeEach(() => {
  pathnameMock.mockReturnValue("/admin/dashboard");
});

describe("<AdminLayout>", () => {
  it("renders all 11 navigation items as links", () => {
    render(
      <AdminLayout user={null}>
        <div data-testid="page">page</div>
      </AdminLayout>
    );
    const expectedLabels = [
      "Dashboard",
      "Users",
      "Orders",
      "Invoices",
      "Payments",
      "Pending Domains",
      "Support Tickets",
      "Hosting",
      "Domains",
      "TLD Pricing",
      "Settings",
    ];
    for (const label of expectedLabels) {
      // Exact match — some labels are substrings of others (e.g., "Domains"
      // is a substring of "Pending Domains"), so use anchored regex.
      expect(
        screen.getByRole("link", { name: new RegExp(`^${label}$`, "i") })
      ).toBeInTheDocument();
    }
  });

  it("slots children into the main content area", () => {
    render(
      <AdminLayout user={null}>
        <div data-testid="page">page goes here</div>
      </AdminLayout>
    );
    expect(screen.getByTestId("page")).toBeInTheDocument();
  });

  it("active link picks up the blue text + border classes", () => {
    pathnameMock.mockReturnValue("/admin/user-management");
    render(
      <AdminLayout user={null}>
        <div />
      </AdminLayout>
    );
    const usersLink = screen.getByRole("link", { name: /^users$/i });
    expect(usersLink.className).toMatch(/text-blue-700/);
    expect(usersLink.className).toMatch(/border-blue-700/);
  });

  it("pathname='/admin' (no /dashboard) still treats Dashboard as active", () => {
    pathnameMock.mockReturnValue("/admin");
    render(
      <AdminLayout user={null}>
        <div />
      </AdminLayout>
    );
    const dashboard = screen.getByRole("link", { name: /dashboard/i });
    expect(dashboard.className).toMatch(/text-blue-700/);
  });

  it("pathname starting with /admin/dns-management treats Domains as active", () => {
    pathnameMock.mockReturnValue("/admin/dns-management");
    render(
      <AdminLayout user={null}>
        <div />
      </AdminLayout>
    );
    const domains = screen.getByRole("link", { name: /^domains$/i });
    expect(domains.className).toMatch(/text-blue-700/);
  });

  it("displays the user initials when firstName+lastName are supplied", () => {
    render(
      <AdminLayout user={{ firstName: "Ada", lastName: "Lovelace", role: "admin" }}>
        <div />
      </AdminLayout>
    );
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    // Initials shown in the avatar circle — first chars of first/last name.
    expect(screen.getByText("AL")).toBeInTheDocument();
  });

  it("falls back to 'AU' initials when user is null", () => {
    render(
      <AdminLayout user={null}>
        <div />
      </AdminLayout>
    );
    expect(screen.getByText("AU")).toBeInTheDocument();
  });

  it("onLogout prop renders a Logout button that calls the callback", async () => {
    const user = userEvent.setup();
    const onLogout = vi.fn();
    render(
      <AdminLayout user={null} onLogout={onLogout}>
        <div />
      </AdminLayout>
    );
    const logout = screen.getByRole("button", { name: /^logout$/i });
    await user.click(logout);
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("no onLogout prop → no Logout button rendered", () => {
    render(
      <AdminLayout user={null}>
        <div />
      </AdminLayout>
    );
    expect(screen.queryByRole("button", { name: /^logout$/i })).not.toBeInTheDocument();
  });

  it("Mobile menu button is labelled and clickable", async () => {
    const user = userEvent.setup();
    render(
      <AdminLayout user={null}>
        <div />
      </AdminLayout>
    );
    const menuBtn = screen.getByRole("button", { name: /open navigation menu/i });
    expect(menuBtn).toBeInTheDocument();
    await user.click(menuBtn);
    // Click is a no-op observable here (sidebar already visible on lg);
    // the assertion is that the button doesn't throw + has the aria-label.
  });
});
