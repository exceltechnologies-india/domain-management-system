/**
 * Component tests for <RefreshButton> (rescan-4 M14).
 * Pins the default render (Refresh label + icon), the showText=false
 * icon-only mode, the isLoading spin + disabled state, the click wiring,
 * and the title attribute defaults to/honours the prop.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import RefreshButton from "@/components/dashboard/RefreshButton";

describe("<RefreshButton>", () => {
  it("renders the 'Refresh' text + icon by default", () => {
    const { container } = render(<RefreshButton onClick={vi.fn()} isLoading={false} />);
    expect(screen.getByRole("button", { name: /refresh/i })).toBeInTheDocument();
    // The Refresh icon is an SVG; it must be present
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("hides the 'Refresh' text when showText is false", () => {
    render(<RefreshButton onClick={vi.fn()} isLoading={false} showText={false} />);
    expect(screen.queryByText(/refresh/i)).not.toBeInTheDocument();
  });

  it("adds the animate-spin class to the icon and disables the button while isLoading is true", () => {
    const { container } = render(<RefreshButton onClick={vi.fn()} isLoading />);
    expect(screen.getByRole("button")).toBeDisabled();
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });

  it("fires onClick on click while not loading", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<RefreshButton onClick={onClick} isLoading={false} />);
    await user.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("defaults the title to 'Refresh Data' and honours a custom title", () => {
    const { rerender } = render(<RefreshButton onClick={vi.fn()} isLoading={false} />);
    expect(screen.getByRole("button")).toHaveAttribute("title", "Refresh Data");
    rerender(<RefreshButton onClick={vi.fn()} isLoading={false} title="Reload list" />);
    expect(screen.getByRole("button")).toHaveAttribute("title", "Reload list");
  });
});
