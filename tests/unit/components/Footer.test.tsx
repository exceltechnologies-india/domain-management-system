/**
 * Component tests for <Footer> (rescan-4 M14).
 * Pins the four sections (company info + quick links + services + social),
 * the policy-link href set (/privacy, /terms-and-conditions, /data-deletion,
 * /cancellation-refund), the current-year copyright line, and the
 * accessible social-media aria-labels.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import Footer from "@/components/Footer";

describe("<Footer>", () => {
  it("renders the brand tagline + the Company/Support link columns with hrefs", () => {
    render(<Footer />);
    // FooterModern (default variant) — brand tagline replaces the old prose.
    expect(screen.getByText(/Empowering Businesses Online/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^about us$/i })).toHaveAttribute("href", "/about");
    expect(screen.getByRole("link", { name: /^contact us$/i })).toHaveAttribute("href", "/contact");
    expect(screen.getByRole("link", { name: /^help center$/i })).toHaveAttribute("href", "/contact");
  });

  it("renders the Hosting + Domain columns with Web Hosting linked to /hosting", () => {
    render(<Footer />);
    expect(screen.getByRole("link", { name: /^web hosting$/i })).toHaveAttribute("href", "/hosting");
    expect(screen.getByRole("link", { name: /^domain search$/i })).toHaveAttribute("href", "/domains-home");
    expect(screen.getByRole("link", { name: /^transfer domain$/i })).toHaveAttribute("href", "/domains-home");
  });

  it("renders the four policy links in the bottom strip", () => {
    render(<Footer />);
    expect(screen.getByRole("link", { name: /privacy policy/i })).toHaveAttribute("href", "/privacy");
    expect(screen.getByRole("link", { name: /terms and conditions/i })).toHaveAttribute(
      "href",
      "/terms-and-conditions"
    );
    expect(screen.getByRole("link", { name: /data deletion/i })).toHaveAttribute("href", "/data-deletion");
    expect(screen.getByRole("link", { name: /cancellation & refund/i })).toHaveAttribute(
      "href",
      "/cancellation-refund"
    );
  });

  it("copyright line contains the current year + the company name", () => {
    render(<Footer />);
    const year = new Date().getFullYear();
    expect(
      screen.getByText(new RegExp(`© ${year} Anutech Digital Private Limited`))
    ).toBeInTheDocument();
  });

  it("the three social-media links carry accessible aria-labels", () => {
    render(<Footer />);
    expect(screen.getByRole("link", { name: /^facebook$/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^instagram$/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^linkedin$/i })).toBeInTheDocument();
  });

  it("className passes through to the outer footer element", () => {
    const { container } = render(<Footer className="custom-cls" />);
    const footer = container.querySelector("footer");
    expect(footer?.className).toContain("custom-cls");
  });
});
