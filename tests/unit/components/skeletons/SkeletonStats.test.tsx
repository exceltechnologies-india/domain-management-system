/**
 * Component tests for <SkeletonStats> (rescan-4 M14).
 * Pins the 4-card grid render with 4 placeholders per card
 * (icon + value + label + trend = 16 SkeletonBase children total).
 */
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import SkeletonStats from "@/components/skeletons/SkeletonStats";

describe("<SkeletonStats>", () => {
  it("renders the 4-card grid (4 cards × 4 SkeletonBase = 16 placeholders)", () => {
    const { container } = render(<SkeletonStats />);
    const skeletons = container.querySelectorAll(".animate-pulse");
    expect(skeletons).toHaveLength(16);
  });

  it("uses a grid container at the top level", () => {
    const { container } = render(<SkeletonStats />);
    const root = container.firstChild as HTMLElement;
    expect(root.className).toMatch(/grid/);
  });
});
