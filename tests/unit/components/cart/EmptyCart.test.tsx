/**
 * Component tests for <EmptyCart> (rescan-4 M14 — first component-render slice).
 * EmptyCart is a pure presentational server-eligible component; this pins the
 * empty-state copy and the two CTA links so a future refactor can't silently
 * drop them.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import EmptyCart from "@/components/cart/EmptyCart";

describe("<EmptyCart>", () => {
  it("renders the empty-state heading and prompt", () => {
    render(<EmptyCart />);
    expect(screen.getByRole("heading", { name: /your cart is empty/i })).toBeInTheDocument();
    expect(screen.getByText(/no domains or hosting plans in your cart yet/i)).toBeInTheDocument();
  });

  it("links to domain search and hosting", () => {
    render(<EmptyCart />);
    expect(screen.getByRole("link", { name: /find my domain/i })).toHaveAttribute("href", "/domains/search");
    expect(screen.getByRole("link", { name: /browse hosting/i })).toHaveAttribute("href", "/hosting");
  });
});
