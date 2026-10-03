/**
 * Component tests for <Logo> (rescan-4 M14).
 * Pins the default-linked render (Next/Link wrapping at the default '/'
 * href), the unlinked path when href='' is passed, the variant fork
 * (light→black-logo.png + dark text vs dark→black-logo.png whitened via CSS filter + white
 * text), the size→class mapping, and the conditional company-name
 * label under `showText`.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect, afterEach } from "vitest";
import Logo from "@/components/Logo";

describe("<Logo>", () => {
  it("renders a Next/Link wrapping the logo at the default '/' href", () => {
    render(<Logo />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/");
    expect(link).toHaveAttribute("aria-label", "Anutech Digital");
  });

  it("honours a custom `href` prop", () => {
    render(<Logo href="/admin" />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/admin");
  });

  /**
   * The default href is no longer the literal '/': it follows the front
   * door. This mark sits on login, register, forgot-password,
   * reset-password and activate, so this single default is what sends all
   * five to ResellerOS rather than to DMS's marketing homepage.
   */
  describe("default href follows the front door", () => {
    const ORIGINAL = process.env.NEXT_PUBLIC_RESELLEROS_URL;
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_RESELLEROS_URL;
      else process.env.NEXT_PUBLIC_RESELLEROS_URL = ORIGINAL;
    });

    it("points at ResellerOS when it is configured", () => {
      process.env.NEXT_PUBLIC_RESELLEROS_URL = "https://app.example.com";
      render(<Logo />);
      expect(screen.getByRole("link")).toHaveAttribute(
        "href",
        "https://app.example.com"
      );
    });

    it("falls back to '/' when it is not, so standalone DMS is unchanged", () => {
      delete process.env.NEXT_PUBLIC_RESELLEROS_URL;
      render(<Logo />);
      expect(screen.getByRole("link")).toHaveAttribute("href", "/");
    });

    it("an explicit href still wins — the signed-in nav sends it to the panel", () => {
      process.env.NEXT_PUBLIC_RESELLEROS_URL = "https://app.example.com";
      render(<Logo href="/dashboard" />);
      expect(screen.getByRole("link")).toHaveAttribute("href", "/dashboard");
    });
  });

  it("renders without a Link wrapper when href is falsy", () => {
    render(<Logo href="" />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("Anutech Digital")).toBeInTheDocument();
  });

  /* 3 Oct 2026 (Pawan): DMS is a backend for ResellerOS, so the mark is the ResellerOS
     storefront's — the round "A" plus "Anutech Digital" — never the old "ANUTECH DIGITAL PVT
     LTD" image or "Private Limited" wording. */
  it("always shows the storefront wordmark, whatever showText says", () => {
    for (const showText of [undefined, false, true]) {
      const { unmount } = render(<Logo showText={showText} />);
      expect(screen.getByText("Anutech Digital")).toBeInTheDocument();
      expect(screen.queryByText(/private limited/i)).not.toBeInTheDocument();
      unmount();
    }
  });

  it("uses the storefront mark, not the old full logo image", () => {
    const { container } = render(<Logo />);
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img.src).toMatch(/anutech-digital-logo\.png/);
    expect(img.src).not.toMatch(/black-logo/);
  });

  it("variant='dark' → white wordmark; 'light' (default) → ink", () => {
    const dark = render(<Logo variant="dark" />);
    expect(screen.getByText("Anutech Digital").className).toMatch(/text-white/);
    dark.unmount();
    render(<Logo />);
    expect(screen.getByText("Anutech Digital").className).toMatch(/text-ink/);
  });

  it("size sets the mark close to the storefront header's 34px", () => {
    const { container } = render(<Logo size="lg" />);
    expect(container.querySelector("img")).toHaveAttribute("width", "34");
  });
});
