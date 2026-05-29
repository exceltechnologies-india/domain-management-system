/**
 * Component tests for the plain <LoadingSpinner> (rescan-4 M14).
 * Note: a richer `<LoadingSpinner>` exists under @/components/user/
 * (covered in slice 7bv). This one is the simpler primitive used in
 * non-page contexts. Pins the default md size, the sm/lg variants, and
 * the className passthrough on the outer wrapper.
 */
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import LoadingSpinner from "@/components/LoadingSpinner";

describe("<LoadingSpinner>", () => {
  it("renders a spinning div with the default md size (h-8 w-8)", () => {
    const { container } = render(<LoadingSpinner />);
    const spinner = container.querySelector(".animate-spin");
    expect(spinner).not.toBeNull();
    expect(spinner?.className).toMatch(/h-8/);
    expect(spinner?.className).toMatch(/w-8/);
  });

  it("maps size='sm' to h-4 w-4", () => {
    const { container } = render(<LoadingSpinner size="sm" />);
    expect(container.querySelector(".animate-spin")?.className).toMatch(/h-4/);
  });

  it("maps size='lg' to h-12 w-12", () => {
    const { container } = render(<LoadingSpinner size="lg" />);
    expect(container.querySelector(".animate-spin")?.className).toMatch(/h-12/);
  });

  it("passes className through to the outer wrapper", () => {
    const { container } = render(<LoadingSpinner className="my-loader-cls" />);
    expect((container.firstChild as HTMLElement).className).toContain("my-loader-cls");
  });
});
