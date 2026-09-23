/**
 * Component tests for the admin-route skeletons (rescan-4 M14).
 *
 * Pins AdminTableRowsSkeleton's cell counts. The AdminLayoutSkeleton block
 * that used to sit below was DELETED with the component: it rendered it with
 * no AdminShellContext provider and asserted the dark-blue chrome appeared,
 * which no caller could ever produce — all 19 importers were under app/admin,
 * where the shell is always mounted. See tests/unit/components/admin/
 * AdminShell.test.tsx for the invariant that replaced it.
 */
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { AdminTableRowsSkeleton } from "@/components/skeletons/AdminLayout";

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
