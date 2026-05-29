/**
 * Component tests for the shadcn <Card> primitive set (rescan-4 M14).
 * Distinct from `components/Card.tsx` (a framer-motion + variant
 * wrapper) covered in slice 7cc — this is the bare shadcn building
 * block. Pins the rendered tag + class set + ref forwarding for each
 * sub-component, plus the className merging via cn().
 */
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { createRef } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";

describe("shadcn <Card> primitives", () => {
  it("Card renders a div with rounded-lg + border + bg-card", () => {
    const { container } = render(<Card>kid</Card>);
    const el = container.firstChild as HTMLElement;
    expect(el.tagName).toBe("DIV");
    expect(el.className).toMatch(/rounded-lg/);
    expect(el.className).toMatch(/border/);
    expect(el.className).toMatch(/bg-card/);
  });

  it("Card merges custom className alongside the defaults via cn()", () => {
    const { container } = render(<Card className="my-cls">x</Card>);
    expect((container.firstChild as HTMLElement).className).toMatch(/my-cls/);
    expect((container.firstChild as HTMLElement).className).toMatch(/rounded-lg/);
  });

  it("Card forwards refs", () => {
    const ref = createRef<HTMLDivElement>();
    render(<Card ref={ref}>x</Card>);
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
  });

  it("CardHeader uses the flex-col + p-6 spacing", () => {
    const { container } = render(<CardHeader>h</CardHeader>);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toMatch(/flex/);
    expect(el.className).toMatch(/flex-col/);
    expect(el.className).toMatch(/p-6/);
  });

  it("CardTitle renders as an <h3> with text-2xl font-semibold", () => {
    const { container } = render(<CardTitle>title</CardTitle>);
    const el = container.firstChild as HTMLElement;
    expect(el.tagName).toBe("H3");
    expect(el.className).toMatch(/text-2xl/);
    expect(el.className).toMatch(/font-semibold/);
  });

  it("CardDescription renders as a <p> with text-sm text-muted-foreground", () => {
    const { container } = render(<CardDescription>desc</CardDescription>);
    const el = container.firstChild as HTMLElement;
    expect(el.tagName).toBe("P");
    expect(el.className).toMatch(/text-sm/);
    expect(el.className).toMatch(/text-muted-foreground/);
  });

  it("CardContent uses p-6 pt-0 (no top padding to abut header)", () => {
    const { container } = render(<CardContent>c</CardContent>);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toMatch(/p-6/);
    expect(el.className).toMatch(/pt-0/);
  });

  it("CardFooter uses flex items-center p-6 pt-0", () => {
    const { container } = render(<CardFooter>f</CardFooter>);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toMatch(/flex/);
    expect(el.className).toMatch(/items-center/);
    expect(el.className).toMatch(/p-6/);
    expect(el.className).toMatch(/pt-0/);
  });
});
