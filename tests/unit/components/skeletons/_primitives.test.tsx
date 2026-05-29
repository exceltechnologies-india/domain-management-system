/**
 * Component tests for the skeleton primitives (rescan-4 M14).
 * Pins the per-primitive child counts and class signatures so a future
 * refactor of these shared building blocks surfaces in tests.
 */
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import {
  Sk,
  PageHeader,
  TableSkeleton,
  FormSection,
} from "@/components/skeletons/_primitives";

describe("Skeleton primitives", () => {
  it("Sk renders a div with the 'skeleton' class + passthrough className", () => {
    const { container } = render(<Sk className="h-8 w-8 rounded-full" />);
    const el = container.firstChild as HTMLElement;
    expect(el.tagName).toBe("DIV");
    expect(el.className).toMatch(/skeleton/);
    expect(el.className).toMatch(/h-8/);
    expect(el.className).toMatch(/rounded-full/);
  });

  it("PageHeader renders 3 placeholders (2 title bars + 1 action button)", () => {
    const { container } = render(<PageHeader />);
    expect(container.querySelectorAll(".skeleton")).toHaveLength(3);
  });

  it("PageHeader wide=true widens the title bar from w-48 → w-64", () => {
    const { container: c1 } = render(<PageHeader />);
    expect(c1.querySelector(".w-48")).not.toBeNull();
    expect(c1.querySelector(".w-64")).toBeNull();

    const { container: c2 } = render(<PageHeader wide />);
    expect(c2.querySelector(".w-64")).not.toBeNull();
    expect(c2.querySelector(".w-48")).toBeNull();
  });

  it("TableSkeleton renders 2 toolbar + N header cells + N×R data cells", () => {
    const { container } = render(<TableSkeleton rows={3} cols={4} />);
    // toolbar (search + filter) = 2, header = 4, data = 3*4 = 12 → 18
    expect(container.querySelectorAll(".skeleton")).toHaveLength(2 + 4 + 12);
  });

  it("TableSkeleton defaults to 6 rows × 5 cols (37 placeholders total)", () => {
    const { container } = render(<TableSkeleton />);
    expect(container.querySelectorAll(".skeleton")).toHaveLength(2 + 5 + 5 * 6);
  });

  it("FormSection with title=true + fields=4 renders 1 title bar + 4 label+input pairs = 9", () => {
    const { container } = render(<FormSection />);
    // title bar (1) + 4 fields × 2 (label + input) = 9
    expect(container.querySelectorAll(".skeleton")).toHaveLength(1 + 4 * 2);
  });

  it("FormSection title=false drops the title bar", () => {
    const { container } = render(<FormSection title={false} fields={3} />);
    // No title bar, 3 fields × 2 = 6
    expect(container.querySelectorAll(".skeleton")).toHaveLength(3 * 2);
  });
});
