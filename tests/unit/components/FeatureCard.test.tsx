/**
 * Component tests for <FeatureCard> (rescan-4 M14).
 * Pins the icon + title (h4) + description render, the wrapping in a
 * hover-enabled <Card>, and the className passthrough.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import FeatureCard from "@/components/FeatureCard";

describe("<FeatureCard>", () => {
  it("renders the icon + h4 title + description text", () => {
    render(
      <FeatureCard
        icon={<svg data-testid="feat-icon" />}
        title="Fast DNS"
        description="Edge-optimised propagation."
      />
    );
    expect(screen.getByTestId("feat-icon")).toBeInTheDocument();
    const heading = screen.getByRole("heading", { name: /fast dns/i });
    expect(heading.tagName).toBe("H4");
    expect(screen.getByText(/edge-optimised propagation\./i)).toBeInTheDocument();
  });

  it("passes className through to the underlying Card wrapper", () => {
    const { container } = render(
      <FeatureCard
        icon={null}
        title="x"
        description="y"
        className="bonus-cls"
      />
    );
    // The Card's inner div carries the className. Walk down to find it.
    const inner = container.querySelector(".bonus-cls");
    expect(inner).not.toBeNull();
    expect(inner!.className).toMatch(/rounded-lg/);
  });

  it("delegates to a hover-enabled Card by default (picks up hover:shadow-xl)", () => {
    const { container } = render(
      <FeatureCard icon={null} title="x" description="y" />
    );
    const cardInner = container.querySelector(".rounded-lg")!;
    expect(cardInner.className).toMatch(/hover:shadow-xl/);
  });
});
