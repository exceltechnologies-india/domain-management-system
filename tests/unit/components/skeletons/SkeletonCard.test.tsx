/**
 * Component tests for <SkeletonCard> (rescan-4 M14).
 * Pure composition of SkeletonBase. Pins the card-shell rendering with
 * the icon circle + 1 title bar + 3 description bars (5 SkeletonBase
 * children total).
 */
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import SkeletonCard from "@/components/skeletons/SkeletonCard";

describe("<SkeletonCard>", () => {
  it("renders the card shell with 5 SkeletonBase placeholders (icon + title + 3 lines)", () => {
    const { container } = render(<SkeletonCard />);
    // Each SkeletonBase is a div with animate-pulse — count them
    const skeletons = container.querySelectorAll(".animate-pulse");
    expect(skeletons).toHaveLength(5);
  });

  it("renders a circular icon placeholder", () => {
    const { container } = render(<SkeletonCard />);
    expect(container.querySelector(".rounded-full")).not.toBeNull();
  });
});
