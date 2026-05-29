/**
 * Component tests for <AuthShell> (rescan-4 M14).
 * The shared two-column shell used by /login + /register. Pins the
 * form-side title (h1) + subtitle + children, the brand-panel default
 * eyebrow + headline, the per-panel overrides via `panelEyebrow` /
 * `panelTitle`, and the current-year footer copyright.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import AuthShell from "@/components/AuthShell";

describe("<AuthShell>", () => {
  it("renders the form-side title as an <h1>", () => {
    render(
      <AuthShell title="Sign in to your account">
        <input data-testid="form-input" />
      </AuthShell>
    );
    const heading = screen.getByRole("heading", { name: /sign in to your account/i });
    expect(heading.tagName).toBe("H1");
  });

  it("renders the subtitle when supplied; hides it when omitted", () => {
    const { rerender } = render(
      <AuthShell title="X" subtitle="Welcome back, please log in">
        <span />
      </AuthShell>
    );
    expect(screen.getByText(/welcome back, please log in/i)).toBeInTheDocument();

    rerender(
      <AuthShell title="X">
        <span />
      </AuthShell>
    );
    expect(screen.queryByText(/welcome back, please log in/i)).not.toBeInTheDocument();
  });

  it("renders the form children inside the right-hand panel", () => {
    render(
      <AuthShell title="X">
        <input data-testid="form-input" />
      </AuthShell>
    );
    expect(screen.getByTestId("form-input")).toBeInTheDocument();
  });

  it("uses the default brand-panel eyebrow + title when none supplied", () => {
    render(
      <AuthShell title="X">
        <span />
      </AuthShell>
    );
    // 'Anutech Digital' appears in both the eyebrow chip AND the footer
    // copyright line; assert via getAllByText to acknowledge both.
    expect(screen.getAllByText(/Anutech Digital/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/clean way to own your online identity/i)).toBeInTheDocument();
  });

  it("overrides panelEyebrow + panelTitle when supplied", () => {
    render(
      <AuthShell title="X" panelEyebrow="Get started" panelTitle="Create your account today">
        <span />
      </AuthShell>
    );
    expect(screen.getByText(/get started/i)).toBeInTheDocument();
    expect(screen.getByText(/create your account today/i)).toBeInTheDocument();
  });

  it("renders the current-year footer copyright", () => {
    render(
      <AuthShell title="X">
        <span />
      </AuthShell>
    );
    const year = new Date().getFullYear();
    expect(
      screen.getByText(new RegExp(`© ${year} Anutech Digital Private Limited`))
    ).toBeInTheDocument();
  });

  it("the brand-panel Logo wraps a link back to '/'", () => {
    render(
      <AuthShell title="X">
        <span />
      </AuthShell>
    );
    const homeLinks = screen.getAllByRole("link").filter((l) => l.getAttribute("href") === "/");
    expect(homeLinks.length).toBeGreaterThanOrEqual(1);
  });
});
