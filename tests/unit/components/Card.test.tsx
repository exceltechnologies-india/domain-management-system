/**
 * Component tests for <Card> (rescan-4 M14).
 * Pins the wrapper classes (rounded-lg + variant + padding), the three
 * variant branches, the three padding sizes, the hover-classes opt-in,
 * the animate=false branch (skips the motion.div wrapper), and the
 * children render.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import Card from "@/components/Card";

describe("<Card>", () => {
  it("renders children inside a rounded-lg wrapper with default variant + md padding", () => {
    const { container } = render(<Card animate={false}>Hello card</Card>);
    expect(screen.getByText("Hello card")).toBeInTheDocument();
    const inner = container.firstChild as HTMLElement;
    expect(inner.className).toMatch(/rounded-lg/);
    expect(inner.className).toMatch(/bg-white/);
    expect(inner.className).toMatch(/border-gray-200/);
    expect(inner.className).toMatch(/p-6/);
  });

  it("variant='elevated' uses shadow-lg instead of a visible border", () => {
    const { container } = render(<Card animate={false} variant="elevated">x</Card>);
    expect((container.firstChild as HTMLElement).className).toMatch(/shadow-lg/);
  });

  it("variant='outlined' uses border-2", () => {
    const { container } = render(<Card animate={false} variant="outlined">x</Card>);
    expect((container.firstChild as HTMLElement).className).toMatch(/border-2/);
  });

  it("padding='sm' → p-4, padding='lg' → p-8", () => {
    const { container, rerender } = render(<Card animate={false} padding="sm">x</Card>);
    expect((container.firstChild as HTMLElement).className).toMatch(/p-4/);
    rerender(<Card animate={false} padding="lg">x</Card>);
    expect((container.firstChild as HTMLElement).className).toMatch(/p-8/);
  });

  it("hover=true adds the hover-shadow + translate transitions", () => {
    const { container } = render(<Card animate={false} hover>x</Card>);
    expect((container.firstChild as HTMLElement).className).toMatch(/hover:shadow-xl/);
  });

  it("animate=false renders ONLY the inner div (no motion wrapper)", () => {
    const { container } = render(<Card animate={false}>x</Card>);
    const root = container.firstChild as HTMLElement;
    expect(root.nodeName).toBe("DIV");
    // The bare inner div is the root — its own class carries rounded-lg.
    expect(root.className).toMatch(/rounded-lg/);
  });

  it("animate=true (default) wraps the inner div in a motion.div", () => {
    const { container } = render(<Card>x</Card>);
    const root = container.firstChild as HTMLElement;
    // The motion wrapper has NO rounded-lg class; only its child does.
    expect(root.className || "").not.toMatch(/rounded-lg/);
    expect(root.firstChild).not.toBeNull();
    expect((root.firstChild as HTMLElement).className).toMatch(/rounded-lg/);
  });
});
