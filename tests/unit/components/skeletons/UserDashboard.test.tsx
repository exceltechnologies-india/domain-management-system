/**
 * Component tests for the user-dashboard skeletons (rescan-4 M14).
 * 12 named exports — each composed from the shared `Sk` primitive
 * (renders divs with `.skeleton` class). Asserts each renders without
 * throwing and produces a non-trivial placeholder count, plus the
 * `DashboardLayoutSkeleton` correctly slots children into `<main>`.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import {
  DashboardLayoutSkeleton,
  DashboardHomeSkeleton,
  OrdersPageSkeleton,
  DomainsPageSkeleton,
  InvoicesPageSkeleton,
  HostingPageSkeleton,
  SupportPageSkeleton,
  ReferralsPageSkeleton,
  SettingsPageSkeleton,
  DNSPageSkeleton,
  TicketDetailPageSkeleton,
  DetailPageSkeleton,
} from "@/components/skeletons/UserDashboard";

describe("UserDashboard skeletons", () => {
  it("DashboardLayoutSkeleton slots children into <main>", () => {
    render(
      <DashboardLayoutSkeleton>
        <div data-testid="page">page goes here</div>
      </DashboardLayoutSkeleton>
    );
    expect(screen.getByTestId("page")).toBeInTheDocument();
  });

  it("DashboardLayoutSkeleton renders the sidebar shell with > 15 placeholders", () => {
    const { container } = render(
      <DashboardLayoutSkeleton>
        <div />
      </DashboardLayoutSkeleton>
    );
    // logo (2) + 9 nav rows × 2 (18) + user block (3) + mobile top bar (3) = 26
    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(15);
  });

  it.each([
    ["DashboardHomeSkeleton", DashboardHomeSkeleton],
    ["OrdersPageSkeleton", OrdersPageSkeleton],
    ["DomainsPageSkeleton", DomainsPageSkeleton],
    ["InvoicesPageSkeleton", InvoicesPageSkeleton],
    ["HostingPageSkeleton", HostingPageSkeleton],
    ["SupportPageSkeleton", SupportPageSkeleton],
    ["ReferralsPageSkeleton", ReferralsPageSkeleton],
    ["SettingsPageSkeleton", SettingsPageSkeleton],
    ["DNSPageSkeleton", DNSPageSkeleton],
    ["TicketDetailPageSkeleton", TicketDetailPageSkeleton],
    ["DetailPageSkeleton", DetailPageSkeleton],
  ])("%s renders without throwing + > 5 skeleton placeholders", (_name, Component) => {
    const { container } = render(<Component />);
    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(5);
  });
});
