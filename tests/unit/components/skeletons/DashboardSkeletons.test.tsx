/**
 * Component tests for the user-dashboard skeleton primitives (rescan-4 M14).
 * Different from `skeletons/_primitives` (which uses the global `.skeleton`
 * class) — these use Tailwind `animate-pulse` on each bar. Pins the
 * placeholder counts for each composition + the `DashboardSkeletons`
 * default export which is intentionally null.
 */
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import DashboardSkeletons, {
  SkeletonBar,
  SectionCardSkeleton,
  TableSkeleton,
  ListSkeleton,
  FormSkeleton,
  DNSManagementSkeleton,
  OrdersSkeleton,
  DomainsSkeleton,
  AdminTableSkeleton,
} from "@/components/skeletons/DashboardSkeletons";

describe("DashboardSkeletons", () => {
  it("SkeletonBar renders a single animate-pulse div with default w-full h-4", () => {
    const { container } = render(<SkeletonBar />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toMatch(/animate-pulse/);
    expect(el.className).toMatch(/w-full/);
    expect(el.className).toMatch(/h-4/);
  });

  it("SkeletonBar honours width + height overrides", () => {
    const { container } = render(<SkeletonBar width="w-1/3" height="h-10" />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toMatch(/w-1\/3/);
    expect(el.className).toMatch(/h-10/);
  });

  it("SectionCardSkeleton default = 1 title bar + 3 rows = 4 placeholders", () => {
    const { container } = render(<SectionCardSkeleton />);
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(4);
  });

  it("SectionCardSkeleton rows prop scales the body bar count", () => {
    const { container } = render(<SectionCardSkeleton rows={7} />);
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(1 + 7);
  });

  it("TableSkeleton default = 1 header + 6 × 5 cells = 31 placeholders", () => {
    const { container } = render(<TableSkeleton />);
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(1 + 6 * 5);
  });

  it("TableSkeleton with rows=2 cols=3 → 1 + 6 = 7 placeholders", () => {
    const { container } = render(<TableSkeleton rows={2} cols={3} />);
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(1 + 2 * 3);
  });

  it("ListSkeleton renders 2 bars per item (title + subtitle)", () => {
    const { container } = render(<ListSkeleton items={4} />);
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(4 * 2);
  });

  it("FormSkeleton renders 8 fields × 2 bars + 1 submit = 17 placeholders", () => {
    const { container } = render(<FormSkeleton />);
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(8 * 2 + 1);
  });

  it("DNSManagementSkeleton composes a SectionCard(2) + Table(4×5) = 3 + 21 = 24", () => {
    const { container } = render(<DNSManagementSkeleton />);
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(1 + 2 + 1 + 4 * 5);
  });

  it("OrdersSkeleton/DomainsSkeleton/AdminTableSkeleton delegate to TableSkeleton with their dimensions", () => {
    const ordersContainer = render(<OrdersSkeleton />).container;
    expect(ordersContainer.querySelectorAll(".animate-pulse")).toHaveLength(1 + 6 * 6);

    const domainsContainer = render(<DomainsSkeleton />).container;
    expect(domainsContainer.querySelectorAll(".animate-pulse")).toHaveLength(1 + 6 * 5);

    const adminContainer = render(<AdminTableSkeleton />).container;
    expect(adminContainer.querySelectorAll(".animate-pulse")).toHaveLength(1 + 8 * 6);
  });

  it("default export <DashboardSkeletons /> renders null (barrel-only file)", () => {
    const { container } = render(<DashboardSkeletons />);
    expect(container.firstChild).toBeNull();
  });
});
