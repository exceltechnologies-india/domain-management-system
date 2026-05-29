/**
 * Component tests for <MotionProvider> (rescan-4 M14).
 * Tiny wrapper around framer-motion's MotionConfig with
 * `reducedMotion="user"`. The only behavior to pin is that it renders
 * its children.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import MotionProvider from "@/components/MotionProvider";

describe("<MotionProvider>", () => {
  it("renders its children inside the MotionConfig wrapper", () => {
    render(
      <MotionProvider>
        <div data-testid="kid">hi</div>
      </MotionProvider>
    );
    expect(screen.getByTestId("kid")).toBeInTheDocument();
  });
});
