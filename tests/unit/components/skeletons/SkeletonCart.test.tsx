/**
 * Component tests for <SkeletonCart> (rescan-4 M14).
 * Pins the SkeletonBase placeholder count + the high-level shell
 * (header + 4-col trust strip + items area + summary card). Built atop
 * SkeletonBase (covered in slice 7ca) so every placeholder carries
 * `animate-pulse`. The exact count is a snapshot of the current shell;
 * a future shell change will fail loudly here and force an audit.
 */
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import SkeletonCart from "@/components/skeletons/SkeletonCart";

describe("<SkeletonCart>", () => {
  it("renders the full cart-skeleton shell (55 SkeletonBase placeholders)", () => {
    const { container } = render(<SkeletonCart />);
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(55);
  });

  it("renders the 4-column trust-indicator strip", () => {
    const { container } = render(<SkeletonCart />);
    // The trust strip is the first grid-cols-2 md:grid-cols-4 wrapper.
    expect(container.querySelector(".md\\:grid-cols-4")).not.toBeNull();
  });

  it("renders the main 6/7/8-column desktop content grid", () => {
    const { container } = render(<SkeletonCart />);
    expect(container.querySelector(".lg\\:grid-cols-6")).not.toBeNull();
  });
});
