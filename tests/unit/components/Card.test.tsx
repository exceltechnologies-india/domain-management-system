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
    expect(inner.className).toMatch(/bg-paper/);
    expect(inner.className).toMatch(/border-hairline/);
    expect(inner.className).toMatch(/p-6/);
  });

  /* The three variants must stay VISUALLY DISTINCT from one another. Asserting
     a literal class name pinned the old palette and broke on the restyle while
     saying nothing about whether the variants still differ — which is the thing
     worth protecting. These assert the difference instead. */
  it("variant='elevated' lifts off the page more than the default", () => {
    const { container } = render(<Card animate={false} variant="elevated">x</Card>);
    const cls = (container.firstChild as HTMLElement).className;
    expect(cls).toMatch(/shadow-\[0_2px_8px/);
    expect(cls).not.toMatch(/shadow-\[0_1px_2px/);
  });

  it("variant='outlined' carries a stronger border and no shadow", () => {
    const { container } = render(<Card animate={false} variant="outlined">x</Card>);
    const cls = (container.firstChild as HTMLElement).className;
    expect(cls).toMatch(/border-hairline-strong/);
    expect(cls).not.toMatch(/shadow-\[/);
  });

  it("padding='sm' → p-4, padding='lg' → p-8", () => {
    const { container, rerender } = render(<Card animate={false} padding="sm">x</Card>);
    expect((container.firstChild as HTMLElement).className).toMatch(/p-4/);
    rerender(<Card animate={false} padding="lg">x</Card>);
    expect((container.firstChild as HTMLElement).className).toMatch(/p-8/);
  });

  it("hover=true adds a hover shadow + translate", () => {
    const { container } = render(<Card animate={false} hover>x</Card>);
    const cls = (container.firstChild as HTMLElement).className;
    expect(cls).toMatch(/hover:shadow-\[/);
    expect(cls).toMatch(/hover:-translate-y-0\.5/);
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
