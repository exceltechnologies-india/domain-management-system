/**
 * Component tests for <ActionMenu> (rescan-4 M14).
 * The popup menu rendered at click-anchored coordinates. Tests pin the
 * isOpen render gate, the per-item button render, item-click → onClick +
 * onClose, click-outside → onClose, Escape → onClose, and the danger-
 * variant divider that appears above a danger item that isn't the first.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { Eye, Trash2, RefreshCw } from "lucide-react";
import ActionMenu from "@/components/admin/ActionMenu";

const anchor = { x: 100, y: 100 };

describe("<ActionMenu>", () => {
  it("renders nothing when isOpen is false", () => {
    render(
      <ActionMenu
        isOpen={false}
        onClose={vi.fn()}
        anchorPoint={anchor}
        items={[{ label: "View", icon: Eye, onClick: vi.fn() }]}
      />
    );
    expect(screen.queryByRole("button", { name: /view/i })).not.toBeInTheDocument();
  });

  it("renders each item as a button with its label when isOpen is true", () => {
    render(
      <ActionMenu
        isOpen
        onClose={vi.fn()}
        anchorPoint={anchor}
        items={[
          { label: "View Details", icon: Eye, onClick: vi.fn() },
          { label: "Refresh", icon: RefreshCw, onClick: vi.fn(), variant: "info" },
          { label: "Delete", icon: Trash2, onClick: vi.fn(), variant: "danger" },
        ]}
      />
    );
    expect(screen.getByRole("button", { name: /view details/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /refresh/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /delete/i })).toBeInTheDocument();
  });

  it("clicking an item fires both its onClick and the parent's onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onView = vi.fn();
    render(
      <ActionMenu
        isOpen
        onClose={onClose}
        anchorPoint={anchor}
        items={[{ label: "View", icon: Eye, onClick: onView }]}
      />
    );
    await user.click(screen.getByRole("button", { name: /view/i }));
    expect(onView).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("fires onClose when the user mousedowns outside the menu", () => {
    const onClose = vi.fn();
    render(
      <>
        <button data-testid="outside">Outside</button>
        <ActionMenu
          isOpen
          onClose={onClose}
          anchorPoint={anchor}
          items={[{ label: "View", icon: Eye, onClick: vi.fn() }]}
        />
      </>
    );
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("fires onClose on Escape keypress while open", () => {
    const onClose = vi.fn();
    render(
      <ActionMenu
        isOpen
        onClose={onClose}
        anchorPoint={anchor}
        items={[{ label: "View", icon: Eye, onClick: vi.fn() }]}
      />
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores non-Escape keypresses (no onClose)", () => {
    const onClose = vi.fn();
    render(
      <ActionMenu
        isOpen
        onClose={onClose}
        anchorPoint={anchor}
        items={[{ label: "View", icon: Eye, onClick: vi.fn() }]}
      />
    );
    fireEvent.keyDown(document, { key: "Enter" });
    fireEvent.keyDown(document, { key: "a" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders a separator above a danger-variant item that isn't the first", () => {
    const { container } = render(
      <ActionMenu
        isOpen
        onClose={vi.fn()}
        anchorPoint={anchor}
        items={[
          { label: "View", icon: Eye, onClick: vi.fn() },
          { label: "Delete", icon: Trash2, onClick: vi.fn(), variant: "danger" },
        ]}
      />
    );
    // The separator is a styled div with `.h-px.bg-gray-100\/50` — query by class
    expect(container.querySelector(".h-px")).not.toBeNull();
  });

  it("does NOT render a separator before a non-danger variant item", () => {
    const { container } = render(
      <ActionMenu
        isOpen
        onClose={vi.fn()}
        anchorPoint={anchor}
        items={[
          { label: "View", icon: Eye, onClick: vi.fn() },
          { label: "Refresh", icon: RefreshCw, onClick: vi.fn(), variant: "info" },
        ]}
      />
    );
    expect(container.querySelector(".h-px")).toBeNull();
  });
});
