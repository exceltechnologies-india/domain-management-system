/**
 * Component tests for <SkeletonContact> (rescan-4 M14).
 * Pins the two-column form + info shell — form has 4 label+input pairs
 * + a submit (9 placeholders), info has 4 rows of icon + 2 lines (12
 * placeholders) → 21 SkeletonBase children total in a md:grid-cols-2
 * grid.
 */
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import SkeletonContact from "@/components/skeletons/SkeletonContact";

describe("<SkeletonContact>", () => {
  it("renders a 2-column grid wrapper", () => {
    const { container } = render(<SkeletonContact />);
    expect((container.firstChild as HTMLElement).className).toMatch(/md:grid-cols-2/);
  });

  it("renders 21 SkeletonBase placeholders (form 9 + info 12)", () => {
    const { container } = render(<SkeletonContact />);
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(21);
  });
});
