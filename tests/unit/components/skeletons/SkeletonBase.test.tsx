/**
 * Component tests for <SkeletonBase> (rescan-4 M14).
 * Pins the default bg-gray-200 + rounded + animate-pulse render, the
 * animate=false opt-out, and the className passthrough via cn().
 */
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import SkeletonBase from "@/components/skeletons/SkeletonBase";

describe("<SkeletonBase>", () => {
  it("renders a single div with bg-gray-200 + rounded + animate-pulse by default", () => {
    const { container } = render(<SkeletonBase />);
    const el = container.firstChild as HTMLElement;
    expect(el.tagName).toBe("DIV");
    expect(el.className).toMatch(/bg-gray-200/);
    expect(el.className).toMatch(/rounded/);
    expect(el.className).toMatch(/animate-pulse/);
  });

  it("drops animate-pulse when animate=false", () => {
    const { container } = render(<SkeletonBase animate={false} />);
    expect((container.firstChild as HTMLElement).className).not.toMatch(/animate-pulse/);
  });

  it("appends the className prop via cn() while keeping the base classes", () => {
    const { container } = render(<SkeletonBase className="h-8 w-32 my-special" />);
    const cls = (container.firstChild as HTMLElement).className;
    expect(cls).toContain("h-8");
    expect(cls).toContain("w-32");
    expect(cls).toContain("my-special");
    expect(cls).toMatch(/bg-gray-200/);
  });
});
