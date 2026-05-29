/**
 * Component tests for the admin-route skeletons (rescan-4 M14).
 * Pins AdminTableRowsSkeleton's cell counts and the AdminLayoutSkeleton
 * shell (sidebar + topbar + children render slot).
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import {
  AdminTableRowsSkeleton,
  AdminLayoutSkeleton,
} from "@/components/skeletons/AdminLayout";

describe("<AdminTableRowsSkeleton>", () => {
  it("renders the header strip + rows×cols data cells", () => {
    const { container } = render(<AdminTableRowsSkeleton rows={2} cols={4} />);
    // header strip: 4 cells (one per col)
    // each data row: first cell uses an icon tile + 2 lines (3) + (cols-2)
    //   middle cells (1 each) + a 2-button tail (2) → 3 + (4-2)*1 + 2 = 7
    // 2 rows × 7 = 14, + 4 header = 18
    expect(container.querySelectorAll(".skeleton")).toHaveLength(4 + 2 * 7);
  });

  it("defaults to 6 rows × 5 cols", () => {
    const { container } = render(<AdminTableRowsSkeleton />);
    // header 5 + 6 × (3 + (5-2) + 2) = 5 + 6 × 8 = 53
    expect(container.querySelectorAll(".skeleton")).toHaveLength(5 + 6 * 8);
  });
});

describe("<AdminLayoutSkeleton>", () => {
  it("renders the sidebar + topbar shell and slots children into <main>", () => {
    render(
      <AdminLayoutSkeleton>
        <div data-testid="content">page goes here</div>
      </AdminLayoutSkeleton>
    );
    expect(screen.getByTestId("content")).toBeInTheDocument();
    // Sidebar logo block (2) + 8 nav rows × 2 = 18; topbar (2). 20 total.
    const { container } = render(
      <AdminLayoutSkeleton>
        <div />
      </AdminLayoutSkeleton>
    );
    expect(container.querySelectorAll(".skeleton")).toHaveLength(2 + 8 * 2 + 2);
  });
});
