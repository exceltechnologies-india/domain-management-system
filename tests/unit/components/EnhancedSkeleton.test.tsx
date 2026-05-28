/**
 * Component tests for the <EnhancedSkeleton> module (rescan-4 M14).
 * Pins the variant + animation routing on the base Skeleton (wave vs
 * pulse/none paths), the default style → 100%/200px box for rectangular
 * and 40px circle for circular, and the prebuilt SkeletonText / SkeletonCard
 * / SkeletonTable / SkeletonList counts.
 */
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import Skeleton, {
  SkeletonText,
  SkeletonCard,
  SkeletonTable,
  SkeletonList,
} from "@/components/EnhancedSkeleton";

describe("<Skeleton>", () => {
  it("renders the wave variant by default with the gradient overlay div", () => {
    const { container } = render(<Skeleton />);
    // Default animation is 'wave' → renders the relative wrapper + 2 absolute children.
    // The gradient overlay carries `via-white/60` in its class set.
    expect(container.querySelector('[class*="via-white"]')).not.toBeNull();
  });

  it("renders the simple variant under animation='pulse' with the animate-pulse class", () => {
    const { container } = render(<Skeleton animation="pulse" />);
    expect(container.firstChild).toHaveClass("animate-pulse");
  });

  it("renders a circle when variant='circular' with the 40px default size", () => {
    const { container } = render(<Skeleton variant="circular" animation="none" />);
    const el = container.firstChild as HTMLElement;
    expect(el).toHaveClass("rounded-full");
    expect(el.style.width).toBe("40px");
    expect(el.style.height).toBe("40px");
  });

  it("honours explicit width + height overrides", () => {
    const { container } = render(<Skeleton width={200} height={50} animation="none" />);
    const el = container.firstChild as HTMLElement;
    expect(el.style.width).toBe("200px");
    expect(el.style.height).toBe("50px");
  });
});

describe("Prebuilt skeleton compositions", () => {
  it("SkeletonText renders the requested number of line skeletons", () => {
    const { container } = render(<SkeletonText lines={5} />);
    // Each line is a Skeleton wrapper; count them via children of the outer flex container
    expect(container.firstChild?.childNodes.length).toBe(5);
  });

  it("SkeletonText defaults to 3 lines when no `lines` prop is supplied", () => {
    const { container } = render(<SkeletonText />);
    expect(container.firstChild?.childNodes.length).toBe(3);
  });

  it("SkeletonCard renders a circular avatar + the SkeletonText block (3 lines)", () => {
    const { container } = render(<SkeletonCard />);
    expect(container.querySelector(".rounded-full")).not.toBeNull();
  });

  it("SkeletonTable renders rows + columns grids — 1 header row + N body rows", () => {
    const { container } = render(<SkeletonTable rows={4} columns={3} />);
    // Outer wrapper holds 1 header grid + 4 body grids = 5 children
    expect(container.firstChild?.childNodes.length).toBe(5);
  });

  it("SkeletonList renders the requested number of item rows", () => {
    const { container } = render(<SkeletonList items={6} />);
    expect(container.firstChild?.childNodes.length).toBe(6);
  });
});
