/**
 * Component tests for the shadcn <Badge> primitive (rescan-4 M14).
 * Pins the children passthrough, the default variant + each of the four
 * variant class branches, and the className override merging via cn().
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Badge } from "@/components/ui/badge";

describe("<Badge>", () => {
  it("renders children", () => {
    render(<Badge>Active</Badge>);
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("applies the default-variant primary background when no variant is given", () => {
    render(<Badge>x</Badge>);
    expect(screen.getByText("x").className).toMatch(/bg-primary/);
  });

  it("variant='secondary' applies the secondary background", () => {
    render(<Badge variant="secondary">x</Badge>);
    expect(screen.getByText("x").className).toMatch(/bg-secondary/);
  });

  it("variant='destructive' applies the destructive background", () => {
    render(<Badge variant="destructive">x</Badge>);
    expect(screen.getByText("x").className).toMatch(/bg-destructive/);
  });

  it("variant='outline' drops the background and applies text-foreground", () => {
    render(<Badge variant="outline">x</Badge>);
    const el = screen.getByText("x");
    expect(el.className).not.toMatch(/bg-primary|bg-secondary|bg-destructive/);
    expect(el.className).toMatch(/text-foreground/);
  });

  it("merges a custom className alongside the variant classes via cn()", () => {
    render(<Badge className="my-custom">x</Badge>);
    const el = screen.getByText("x");
    expect(el.className).toContain("my-custom");
    expect(el.className).toMatch(/bg-primary/);
  });
});
