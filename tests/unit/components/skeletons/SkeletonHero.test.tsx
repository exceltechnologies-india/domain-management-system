/**
 * Component tests for <SkeletonHero> (rescan-4 M14).
 * Pins the 4 SkeletonBase placeholders (icon + title + subtitle + search
 * box) and the circular icon placeholder.
 */
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import SkeletonHero from "@/components/skeletons/SkeletonHero";

describe("<SkeletonHero>", () => {
  it("renders 4 SkeletonBase placeholders (icon + title + subtitle + search box)", () => {
    const { container } = render(<SkeletonHero />);
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(4);
  });

  it("includes a circular icon placeholder", () => {
    const { container } = render(<SkeletonHero />);
    expect(container.querySelector(".rounded-full")).not.toBeNull();
  });
});
