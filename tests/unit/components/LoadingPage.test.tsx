/**
 * Component tests for <LoadingPage> (rescan-4 M14).
 * Tiny full-page loader. Pins the default 'Loading...' message, the
 * custom-message override, and the showDots=false branch that omits
 * the dots span.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import LoadingPage from "@/components/LoadingPage";

describe("<LoadingPage>", () => {
  it("renders the default 'Loading...' copy with dots span", () => {
    render(<LoadingPage />);
    // The message and dots are split across two motion.span elements, so
    // match on the textual fragments separately.
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
    expect(screen.getByText("...")).toBeInTheDocument();
  });

  it("custom message overrides the default", () => {
    render(<LoadingPage message="Provisioning hosting" />);
    expect(screen.getByText(/Provisioning hosting/)).toBeInTheDocument();
  });

  it("showDots=false omits the trailing dots span", () => {
    render(<LoadingPage message="Almost there" showDots={false} />);
    expect(screen.getByText(/Almost there/)).toBeInTheDocument();
    expect(screen.queryByText("...")).not.toBeInTheDocument();
  });
});
