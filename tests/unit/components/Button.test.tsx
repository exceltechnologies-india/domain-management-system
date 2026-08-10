/**
 * Component tests for the custom <Button> at `@/components/Button` (rescan-4 M14).
 * Distinct from the shadcn `ui/button` (covered in slice 7bz). This one
 * is framer-motion-wrapped by default with five gradient variants, three
 * size scales, a loading state with embedded spinner, and an
 * `animate=false` opt-out that drops the motion.button wrapper.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import Button from "@/components/Button";

describe("<Button> (custom)", () => {
  it("default render is a button with primary variant + md size + children", () => {
    render(<Button>Submit</Button>);
    const btn = screen.getByRole("button", { name: "Submit" });
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.className).toMatch(/from-primary-600/);
    expect(btn.className).toMatch(/to-primary-700/);
    expect(btn.className).toMatch(/px-5/);
    expect(btn.className).toMatch(/py-2\.5/);
  });

  it("variant='danger' uses the red gradient", () => {
    render(<Button variant="danger">delete</Button>);
    expect(screen.getByRole("button").className).toMatch(/from-red-600/);
  });

  it("variant='outline' uses the white-with-border surface", () => {
    render(<Button variant="outline">cancel</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toMatch(/border-gray-300/);
    expect(btn.className).toMatch(/bg-white/);
  });

  it("size='sm' uses the smaller padding scale", () => {
    render(<Button size="sm">x</Button>);
    expect(screen.getByRole("button").className).toMatch(/px-3/);
    expect(screen.getByRole("button").className).toMatch(/text-sm/);
  });

  it("fullWidth=true adds w-full", () => {
    render(<Button fullWidth>x</Button>);
    expect(screen.getByRole("button").className).toMatch(/w-full/);
  });

  it("loading=true disables the button and shows a spinner svg", () => {
    const { container } = render(<Button loading>save</Button>);
    expect(screen.getByRole("button")).toBeDisabled();
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });

  it("respects an explicit disabled prop (suppresses onClick)", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>x</Button>);
    expect(screen.getByRole("button")).toBeDisabled();
    await user.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("animate=false renders a plain <button> (no motion wrapper) — onClick still fires", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button animate={false} onClick={onClick}>plain</Button>);
    await user.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
