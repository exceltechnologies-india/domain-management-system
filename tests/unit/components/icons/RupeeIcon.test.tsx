/**
 * Component tests for <RupeeIcon> (rescan-4 M14).
 * Tiny presentational SVG. Pins the SVG render, the default + custom
 * className mapping, and the ₹ glyph being present in the rendered text.
 */
import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import RupeeIcon from "@/components/icons/RupeeIcon";

describe("<RupeeIcon>", () => {
  it("renders an <svg> element with the default size class set", () => {
    const { container } = render(<RupeeIcon />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("class")).toMatch(/h-6/);
    expect(svg?.getAttribute("class")).toMatch(/w-6/);
  });

  it("honours a custom className", () => {
    const { container } = render(<RupeeIcon className="h-10 w-10 text-blue-600" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("class")).toContain("h-10");
    expect(svg?.getAttribute("class")).toContain("text-blue-600");
  });

  it("includes the ₹ glyph in the rendered SVG content", () => {
    const { container } = render(<RupeeIcon />);
    expect(container.textContent).toContain("₹");
  });
});
