/**
 * Component tests for <PageTransition> (rescan-4 M14).
 * Framer-motion wrapper for page-mount animations. Pins the children
 * passthrough and the className being applied to the motion.div wrapper.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import PageTransition from "@/components/PageTransition";

describe("<PageTransition>", () => {
  it("renders children inside the motion wrapper", () => {
    render(
      <PageTransition>
        <p>page-body</p>
      </PageTransition>
    );
    expect(screen.getByText("page-body")).toBeInTheDocument();
  });

  it("applies the className prop to the motion.div wrapper", () => {
    const { container } = render(
      <PageTransition className="my-page-cls">
        <p>x</p>
      </PageTransition>
    );
    expect((container.firstChild as HTMLElement).className).toContain("my-page-cls");
  });
});
