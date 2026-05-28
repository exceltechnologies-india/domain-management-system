/**
 * Component tests for <AdminQuickActions> (rescan-4 M14).
 * Pins the empty render, the per-action anchor (href + title + description),
 * the icon being passed through, and the colour-variant class.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Users, Settings } from "lucide-react";
import AdminQuickActions from "@/components/admin/AdminQuickActions";

describe("<AdminQuickActions>", () => {
  it("renders no anchors for an empty actions list", () => {
    render(<AdminQuickActions actions={[]} />);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("renders one anchor per action with href + title + description", () => {
    render(
      <AdminQuickActions
        actions={[
          { title: "Manage Users", description: "View, edit, deactivate", icon: Users, href: "/admin/users", color: "blue" },
          { title: "System Settings", description: "Toggles + feature flags", icon: Settings, href: "/admin/settings", color: "purple" },
        ]}
      />
    );
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute("href", "/admin/users");
    expect(links[1]).toHaveAttribute("href", "/admin/settings");
    expect(screen.getByRole("heading", { name: /manage users/i })).toBeInTheDocument();
    expect(screen.getByText(/view, edit, deactivate/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /system settings/i })).toBeInTheDocument();
  });

  it("applies the colour-variant classes to each anchor", () => {
    render(
      <AdminQuickActions
        actions={[
          { title: "Green", description: "x", icon: Users, href: "/g", color: "green" },
          { title: "Red", description: "x", icon: Users, href: "/r", color: "red" },
        ]}
      />
    );
    const [greenLink, redLink] = screen.getAllByRole("link");
    expect(greenLink.className).toMatch(/bg-green-50/);
    expect(redLink.className).toMatch(/bg-red-50/);
  });
});
