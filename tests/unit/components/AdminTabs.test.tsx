/**
 * Component tests for <AdminTabs> (rescan-4 M14).
 * Pins the tab list rendering with icons, the active-tab class mapping,
 * and the per-tab onClick callback wiring.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { Users, Settings, Server } from "lucide-react";
import AdminTabs from "@/components/AdminTabs";

const tabs = (onUsers = vi.fn(), onSettings = vi.fn(), onServer = vi.fn()) => [
  { id: "users", label: "Users", icon: Users, onClick: onUsers },
  { id: "settings", label: "Settings", icon: Settings, onClick: onSettings },
  { id: "server", label: "Server", icon: Server, onClick: onServer },
];

describe("<AdminTabs>", () => {
  it("renders one button per tab with the label visible", () => {
    render(<AdminTabs tabs={tabs()} activeTab="users" />);
    expect(screen.getByRole("button", { name: /users/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /settings/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /server/i })).toBeInTheDocument();
  });

  it("applies the active class only to the matching tab", () => {
    render(<AdminTabs tabs={tabs()} activeTab="settings" />);
    const usersBtn = screen.getByRole("button", { name: /users/i });
    const settingsBtn = screen.getByRole("button", { name: /settings/i });
    expect(settingsBtn.className).toMatch(/border-primary-500/);
    expect(usersBtn.className).toMatch(/border-transparent/);
  });

  it("fires the tab's onClick when clicked (and not the others)", async () => {
    const user = userEvent.setup();
    const onUsers = vi.fn();
    const onSettings = vi.fn();
    const onServer = vi.fn();
    render(<AdminTabs tabs={tabs(onUsers, onSettings, onServer)} activeTab="users" />);
    await user.click(screen.getByRole("button", { name: /settings/i }));
    expect(onSettings).toHaveBeenCalledTimes(1);
    expect(onUsers).not.toHaveBeenCalled();
    expect(onServer).not.toHaveBeenCalled();
  });

  it("handles tabs without onClick gracefully (no crash on click)", async () => {
    const user = userEvent.setup();
    render(<AdminTabs tabs={[{ id: "x", label: "X", icon: Users }]} activeTab="x" />);
    // Should not throw
    await user.click(screen.getByRole("button", { name: /^x$/i }));
  });
});
