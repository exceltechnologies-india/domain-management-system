/**
 * Component tests for <Logo> (rescan-4 M14).
 * Pins the default-linked render (Next/Link wrapping at the default '/'
 * href), the unlinked path when href='' is passed, the variant fork
 * (light→black-logo.png + dark text vs dark→black-logo.png whitened via CSS filter + white
 * text), the size→class mapping, and the conditional company-name
 * label under `showText`.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import Logo from "@/components/Logo";

describe("<Logo>", () => {
  it("renders a Next/Link wrapping the logo at the default '/' href", () => {
    render(<Logo />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/");
    expect(screen.getByAltText(/anutech digital/i)).toBeInTheDocument();
  });

  it("honours a custom `href` prop", () => {
    render(<Logo href="/admin" />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/admin");
  });

  it("renders without a Link wrapper when href is falsy", () => {
    render(<Logo href="" />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByAltText(/anutech digital/i)).toBeInTheDocument();
  });

  it("hides the company-name label by default", () => {
    render(<Logo />);
    expect(screen.queryByText(/anutech digital private limited$/i)).not.toBeInTheDocument();
  });

  it("renders the company-name label under showText={true}", () => {
    render(<Logo showText />);
    // The alt and the label both contain the company name; queryAllByText
    // returns at least one match (the label) plus the alt isn't a text node.
    expect(screen.getAllByText(/anutech digital private limited/i).length).toBeGreaterThan(0);
  });

  it("variant='dark' renders the same logo turned white via CSS filter + white text label", () => {
    render(<Logo variant="dark" showText />);
    const img = screen.getByAltText(/anutech digital/i) as HTMLImageElement;
    // Single asset for both variants; dark is whitened with a CSS filter.
    expect(img.src).toMatch(/black-logo\.png/);
    expect(img.className).toMatch(/brightness-0/);
    expect(img.className).toMatch(/invert/);
    // The label gets the text-white class
    const label = screen.getByText(/anutech digital private limited/i);
    expect(label.className).toMatch(/text-white/);
  });

  it("variant='light' (default) uses the black-logo asset and applies dark text", () => {
    render(<Logo showText />);
    const img = screen.getByAltText(/anutech digital/i) as HTMLImageElement;
    expect(img.src).toMatch(/black-logo\.png/);
    const label = screen.getByText(/anutech digital private limited/i);
    expect(label.className).toMatch(/text-gray-900/);
  });

  it("maps size='lg' to the h-12 md:h-14 class set on the img", () => {
    render(<Logo size="lg" />);
    const img = screen.getByAltText(/anutech digital/i);
    expect(img.className).toMatch(/h-12/);
    expect(img.className).toMatch(/md:h-14/);
  });
});
