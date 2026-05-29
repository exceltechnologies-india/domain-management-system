/**
 * Component tests for the shadcn <Button> primitive (rescan-4 M14).
 * Pins the default-button render, the variant + size class branches, the
 * asChild + Radix Slot composition (renders the child element directly
 * instead of a <button>), the ref forwarding, and the disabled state.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { Button } from "@/components/ui/button";

describe("<Button>", () => {
  it("renders a <button> element with the default variant + size classes", () => {
    render(<Button>Click me</Button>);
    const btn = screen.getByRole("button", { name: /click me/i });
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.className).toMatch(/bg-primary/);
    expect(btn.className).toMatch(/h-10/);
  });

  it("variant='destructive' applies the destructive background class", () => {
    render(<Button variant="destructive">x</Button>);
    expect(screen.getByRole("button").className).toMatch(/bg-destructive/);
  });

  it("variant='outline' uses the border class set instead of a solid background", () => {
    render(<Button variant="outline">x</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toMatch(/border-input/);
    expect(btn.className).not.toMatch(/bg-primary/);
  });

  it("variant='ghost' has no background until hover", () => {
    render(<Button variant="ghost">x</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toMatch(/hover:bg-accent/);
  });

  it("size='sm' uses the h-9 small height class", () => {
    render(<Button size="sm">x</Button>);
    expect(screen.getByRole("button").className).toMatch(/h-9/);
  });

  it("size='icon' uses the square h-10 w-10 class", () => {
    render(<Button size="icon">x</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toMatch(/h-10/);
    expect(btn.className).toMatch(/w-10/);
  });

  it("asChild=true renders the child element via Radix Slot (NOT a <button>)", () => {
    render(
      <Button asChild>
        <a href="/somewhere">link-as-button</a>
      </Button>
    );
    const link = screen.getByRole("link", { name: /link-as-button/i });
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "/somewhere");
    // The button variant classes are still applied to the anchor
    expect(link.className).toMatch(/bg-primary/);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("forwards the ref to the underlying button element", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>x</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it("respects the native disabled attribute", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>x</Button>);
    expect(screen.getByRole("button")).toBeDisabled();
    await user.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });
});
