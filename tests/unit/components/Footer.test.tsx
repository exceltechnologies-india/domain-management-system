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
    expect(screen.getByRole("link", { name: /^about anutech$/i })).toHaveAttribute("href", "/about");
    expect(screen.getByRole("link", { name: /^contact us$/i })).toHaveAttribute("href", "/contact");
    expect(screen.getByRole("link", { name: /^support$/i })).toHaveAttribute("href", "/dashboard/support");
  });

  it("renders the Hosting + Domains columns, mirroring the ResellerOS footer", () => {
    render(<Footer />);
    expect(screen.getByRole("link", { name: /^shared hosting$/i })).toHaveAttribute("href", "/hosting");
    expect(screen.getByRole("link", { name: /^search a domain$/i })).toHaveAttribute("href", "/domains");
    expect(screen.getByRole("link", { name: /^transfer in$/i })).toHaveAttribute("href", "/domains");
  });

  it("lists only what is sold and links nowhere dead (10 Oct 2026)", () => {
    render(<Footer />);
    for (const gone of [/vps hosting/i, /reseller hosting/i, /whois/i, /^blog$/i, /^careers$/i, /knowledge base/i, /system status/i]) {
      expect(screen.queryByRole("link", { name: gone })).toBeNull();
    }
    for (const a of screen.getAllByRole("link")) expect(a.getAttribute("href")).not.toBe("#");
  });

  it("renders the three policy links in the bottom strip, and no data-deletion link", () => {
    render(<Footer />);
    expect(screen.getByRole("link", { name: /privacy policy/i })).toHaveAttribute("href", "/privacy");
    expect(screen.getByRole("link", { name: /terms and conditions/i })).toHaveAttribute(
      "href",
      "/terms-and-conditions"
    );
    // Owner decision, 24 Sep 2026: DMS's /data-deletion page was removed and
    // ResellerOS has none, so the link went with it (lib/reseller-os.ts).
    expect(screen.queryByRole("link", { name: /data deletion/i })).toBeNull();
    expect(screen.getByRole("link", { name: /cancellation & refund/i })).toHaveAttribute(
      "href",
      "/cancellation-refund"
    );
  });

  it("copyright line contains the current year + the company name", () => {
    render(<Footer />);
    const year = new Date().getFullYear();
    expect(
      screen.getByText(new RegExp(`© ${year} Anutech Digital Pvt Ltd`))
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
