/**
 * Component tests for <FAQItem> (rescan-4 M14).
 * Pins the dual control modes — uncontrolled (internal state via useState
 * toggled on click) vs controlled (onToggle callback + isOpen prop) — plus
 * the question/answer rendering and the chevron rotate-180 indicator.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import FAQItem from "@/components/FAQItem";

describe("<FAQItem>", () => {
  it("renders the question and the answer", () => {
    render(<FAQItem question="What's the refund window?" answer="30 days from purchase." />);
    expect(screen.getByRole("button", { name: /what's the refund window/i })).toBeInTheDocument();
    expect(screen.getByText(/30 days from purchase/i)).toBeInTheDocument();
  });

  it("defaults to closed when isOpen is omitted (chevron not rotated)", () => {
    const { container } = render(<FAQItem question="Q" answer="A" />);
    const chevron = container.querySelector("svg");
    expect(chevron?.classList.contains("rotate-180")).toBe(false);
  });

  it("uncontrolled: clicking the question toggles the open state and rotates the chevron", async () => {
    const user = userEvent.setup();
    const { container } = render(<FAQItem question="Q" answer="A" />);
    const btn = screen.getByRole("button", { name: "Q" });
    await user.click(btn);
    const chevron = container.querySelector("svg");
    expect(chevron?.classList.contains("rotate-180")).toBe(true);
    // Second click closes
    await user.click(btn);
    expect(chevron?.classList.contains("rotate-180")).toBe(false);
  });

  it("controlled: calls onToggle on click and reflects the parent's isOpen prop instead of self-state", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const { container, rerender } = render(
      <FAQItem question="Q" answer="A" isOpen={false} onToggle={onToggle} />
    );
    await user.click(screen.getByRole("button", { name: "Q" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    // The component's own state isn't flipped — the parent must rerender with isOpen=true
    let chevron = container.querySelector("svg");
    expect(chevron?.classList.contains("rotate-180")).toBe(false);
    rerender(<FAQItem question="Q" answer="A" isOpen onToggle={onToggle} />);
    chevron = container.querySelector("svg");
    expect(chevron?.classList.contains("rotate-180")).toBe(true);
  });
});
