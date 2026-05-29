/**
 * Component tests for the `skeletons/PageSkeletons` barrel (rescan-4 M14).
 * The file is a backwards-compat re-export of the topical skeleton files
 * (`AdminLayout`, `AdminPages`, `UserDashboard`, `PaymentPages`).
 * Pins a sampling of named exports from each so a future rename of the
 * underlying skeleton surfaces here.
 */
import { describe, it, expect } from "vitest";
import * as barrel from "@/components/skeletons/PageSkeletons";

describe("skeletons/PageSkeletons barrel", () => {
  it("re-exports AdminLayout entries", () => {
    expect(typeof barrel.AdminLayoutSkeleton).toBe("function");
    expect(typeof barrel.AdminTableRowsSkeleton).toBe("function");
  });

  it("re-exports AdminPages entries", () => {
    expect(typeof barrel.AdminUsersPageSkeleton).toBe("function");
    expect(typeof barrel.AdminPaymentsPageSkeleton).toBe("function");
    expect(typeof barrel.AdminDashboardSkeleton).toBe("function");
  });

  it("re-exports UserDashboard entries", () => {
    expect(typeof barrel.DashboardLayoutSkeleton).toBe("function");
    expect(typeof barrel.DashboardHomeSkeleton).toBe("function");
    expect(typeof barrel.InvoicesPageSkeleton).toBe("function");
    expect(typeof barrel.DNSPageSkeleton).toBe("function");
  });

  it("re-exports PaymentPages entries", () => {
    expect(typeof barrel.CheckoutPageSkeleton).toBe("function");
    expect(typeof barrel.PaymentSuccessPageSkeleton).toBe("function");
    expect(typeof barrel.CartPageSkeleton).toBe("function");
  });
});
