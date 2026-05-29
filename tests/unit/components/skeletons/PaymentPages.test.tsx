/**
 * Component tests for the payment-flow skeletons (rescan-4 M14).
 * Three named exports — CheckoutPageSkeleton, PaymentSuccessPageSkeleton,
 * CartPageSkeleton — each composed from the shared `Sk` primitive
 * (which renders divs with the `.skeleton` class). Pins each renders
 * non-empty placeholders.
 */
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import {
  CheckoutPageSkeleton,
  PaymentSuccessPageSkeleton,
  CartPageSkeleton,
} from "@/components/skeletons/PaymentPages";

describe("PaymentPages skeletons", () => {
  it("CheckoutPageSkeleton renders the nav + page-header + content grid with skeleton placeholders", () => {
    const { container } = render(<CheckoutPageSkeleton />);
    const placeholders = container.querySelectorAll(".skeleton");
    expect(placeholders.length).toBeGreaterThan(10);
    // The desktop two-column content grid is a load-bearing class.
    expect(container.querySelector(".lg\\:grid-cols-6")).not.toBeNull();
  });

  it("PaymentSuccessPageSkeleton renders a min-h-screen success-style shell", () => {
    const { container } = render(<PaymentSuccessPageSkeleton />);
    expect(container.querySelector(".min-h-screen")).not.toBeNull();
    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(5);
  });

  it("CartPageSkeleton renders a non-empty placeholder grid", () => {
    const { container } = render(<CartPageSkeleton />);
    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(5);
  });
});
