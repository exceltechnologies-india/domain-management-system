/**
 * Component tests for the shadcn <Switch> primitive (rescan-4 M14).
 * Pins the Radix Switch role + aria-checked binding, the controlled-mode
 * onCheckedChange callback wiring, the disabled state, and the className
 * passthrough.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { Switch } from "@/components/ui/switch";

describe("<Switch>", () => {
  it("renders as a switch role with aria-checked='false' by default", () => {
    render(<Switch />);
    const sw = screen.getByRole("switch");
    expect(sw).toBeInTheDocument();
    expect(sw).toHaveAttribute("aria-checked", "false");
  });

  it("reflects the controlled `checked` prop in aria-checked", () => {
    render(<Switch checked onCheckedChange={vi.fn()} />);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  it("fires onCheckedChange with the new value on click", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch checked={false} onCheckedChange={onCheckedChange} />);
    await user.click(screen.getByRole("switch"));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("does NOT fire onCheckedChange while disabled", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch disabled onCheckedChange={onCheckedChange} />);
    await user.click(screen.getByRole("switch"));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it("merges a custom className alongside the variant classes", () => {
    render(<Switch className="my-extra-cls" />);
    expect(screen.getByRole("switch").className).toContain("my-extra-cls");
  });
});
