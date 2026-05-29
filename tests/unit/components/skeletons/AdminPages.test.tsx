/**
 * Component tests for the admin-page skeletons (rescan-4 M14).
 * 9 named exports — each composed from the shared `Sk` primitive.
 * Asserts each renders + produces non-trivial placeholder counts.
 */
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import {
  AdminUsersPageSkeleton,
  AdminPaymentsPageSkeleton,
  AdminSupportPageSkeleton,
  AdminPendingDomainsPageSkeleton,
  AdminHostingPageSkeleton,
  AdminPricingPageSkeleton,
  AdminGenericPageSkeleton,
  AdminDashboardSkeleton,
  AdminSettingsPageSkeleton,
} from "@/components/skeletons/AdminPages";

describe("AdminPages skeletons", () => {
  it.each([
    ["AdminUsersPageSkeleton", AdminUsersPageSkeleton],
    ["AdminPaymentsPageSkeleton", AdminPaymentsPageSkeleton],
    ["AdminSupportPageSkeleton", AdminSupportPageSkeleton],
    ["AdminPendingDomainsPageSkeleton", AdminPendingDomainsPageSkeleton],
    ["AdminHostingPageSkeleton", AdminHostingPageSkeleton],
    ["AdminPricingPageSkeleton", AdminPricingPageSkeleton],
    ["AdminGenericPageSkeleton", AdminGenericPageSkeleton],
    ["AdminDashboardSkeleton", AdminDashboardSkeleton],
    ["AdminSettingsPageSkeleton", AdminSettingsPageSkeleton],
  ])("%s renders without throwing + > 5 skeleton placeholders", (_name, Component) => {
    const { container } = render(<Component />);
    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(5);
  });
});
