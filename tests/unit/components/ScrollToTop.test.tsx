/**
 * Component tests for <ScrollToTop> (rescan-4 M14).
 * Pins the > 300px scroll-visibility threshold, the hidden-by-default
 * state, and the smooth scroll-to-top behaviour on click.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import ScrollToTop from "@/components/ScrollToTop";

beforeEach(() => {
  Object.defineProperty(window, "pageYOffset", { value: 0, writable: true, configurable: true });
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});

function setScroll(y: number) {
  Object.defineProperty(window, "pageYOffset", { value: y, writable: true, configurable: true });
  fireEvent.scroll(window);
}

describe("<ScrollToTop>", () => {
  it("renders nothing while pageYOffset is at or below 300", () => {
    render(<ScrollToTop />);
    expect(screen.queryByRole("button", { name: /scroll to top/i })).not.toBeInTheDocument();
  });

  it("renders the floating button once the page has scrolled past 300px", () => {
    render(<ScrollToTop />);
    setScroll(500);
    expect(screen.getByRole("button", { name: /scroll to top/i })).toBeInTheDocument();
  });

  it("hides the button again when the page scrolls back to <= 300", () => {
    render(<ScrollToTop />);
    setScroll(500);
    expect(screen.getByRole("button", { name: /scroll to top/i })).toBeInTheDocument();
    setScroll(100);
    expect(screen.queryByRole("button", { name: /scroll to top/i })).not.toBeInTheDocument();
  });

  it("calls window.scrollTo({ top: 0, behavior: 'smooth' }) on click", () => {
    render(<ScrollToTop />);
    setScroll(500);
    fireEvent.click(screen.getByRole("button", { name: /scroll to top/i }));
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });
});
