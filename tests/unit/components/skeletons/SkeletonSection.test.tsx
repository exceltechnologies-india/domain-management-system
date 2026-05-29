/**
 * Component tests for <SkeletonSection> (rescan-4 M14).
 * Pins the default render (title block + 3 cards in 3 columns), the
 * title=false branch (no title placeholders), the cards prop changing
 * the rendered card count, and the columns prop mapping to the right
 * grid-cols class.
 */
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import SkeletonSection from "@/components/skeletons/SkeletonSection";

describe("<SkeletonSection>", () => {
  it("with defaults renders the title block placeholders + 3 cards in a 3-col grid", () => {
    const { container } = render(<SkeletonSection />);
    // Title block: 4 placeholders (icon + heading + 2 desc lines).
    // Each card: 5 placeholders (icon + title + 3 desc lines) → 15.
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(4 + 15);
    expect(container.querySelector(".grid")?.className).toMatch(/lg:grid-cols-3/);
  });

  it("title=false skips the title block (only card placeholders rendered)", () => {
    const { container } = render(<SkeletonSection title={false} />);
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(15);
  });

  it("cards prop controls how many card containers are rendered", () => {
    const { container } = render(<SkeletonSection title={false} cards={5} />);
    // 5 cards × 5 placeholders each = 25
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(25);
  });

  it("columns=4 maps to md:grid-cols-4", () => {
    const { container } = render(<SkeletonSection columns={4} />);
    expect(container.querySelector(".grid")?.className).toMatch(/md:grid-cols-4/);
  });

  it("columns=2 maps to sm:grid-cols-2", () => {
    const { container } = render(<SkeletonSection columns={2} />);
    expect(container.querySelector(".grid")?.className).toMatch(/sm:grid-cols-2/);
  });
});
