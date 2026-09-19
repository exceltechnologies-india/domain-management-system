/**
 * Component tests for <AuthShell> — the shared shell behind /login and /register.
 *
 * Pins the title (h1), the optional subtitle, the children, the current-year
 * footer, and the home link.
 *
 * ─── THE BRAND-PANEL TESTS ARE GONE, AND SO IS THE BRAND PANEL ───────────────
 * Two tests here asserted a default eyebrow + headline and their overrides via
 * `panelEyebrow` / `panelTitle`. That panel — the purple gradient column with a
 * faux uptime card and a feature list — was removed so this app's sign-in
 * matches the billing app's. The props remain in the signature, ignored, so the
 * two callers keep compiling; a test that they still RENDER would now be
 * asserting the thing the change deleted.
 *
 * Replaced below with a test that the props are accepted and produce no output,
 * which is the actual contract now.
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

  it("accepts the retired panel props and renders nothing for them", () => {
    /* LoginForm and MultiStageRegisterForm still pass these. They must stay
       harmless — not throw, not leak into the page — until those two callers
       are tidied. */
    render(
      <AuthShell title="X" panelEyebrow="Get started" panelTitle="Create your account today">
        <span />
      </AuthShell>
    );
    expect(screen.queryByText(/get started/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/create your account today/i)).not.toBeInTheDocument();
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
