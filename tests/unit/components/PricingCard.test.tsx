/**
 * Component tests for <PricingCard> (rescan-4 M14).
 * Pins the heading + subtitle + price/currency/period render, the
 * isPopular banner + ring fork, the original/strike-through + renewal +
 * discount-badge optional rows, the **button-vs-link branch** keyed on
 * onButtonClick presence, and the feature-list rendering (included
 * vs not-included class fork).
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import PricingCard from "@/components/PricingCard";

const BASIC_FEATURES = [
  { text: "Feature A", included: true },
  { text: "Feature B (locked)", included: false },
  { text: "Feature C (highlight)", included: true, highlight: true },
];

describe("<PricingCard>", () => {
  it("renders title + subtitle + currency + price + period", () => {
    render(
      <PricingCard
        title="Pro"
        subtitle="Best for teams"
        price="999"
        features={BASIC_FEATURES}
      />
    );
    expect(screen.getByRole("heading", { name: /pro/i })).toBeInTheDocument();
    expect(screen.getByText("Best for teams")).toBeInTheDocument();
    // currency defaults to ₹ and the price + period render side-by-side.
    expect(screen.getByText("₹999")).toBeInTheDocument();
    expect(screen.getByText("/mo")).toBeInTheDocument();
  });

  it("renders originalPrice (line-through), renewalPrice and discountBadge when supplied", () => {
    render(
      <PricingCard
        title="Pro"
        subtitle="x"
        price="499"
        originalPrice="999"
        renewalPrice="Renews at ₹999/mo"
        discountBadge="50%"
        features={BASIC_FEATURES}
      />
    );
    const original = screen.getByText("₹999");
    expect(original.className).toMatch(/line-through/);
    expect(screen.getByText(/Renews at ₹999\/mo/)).toBeInTheDocument();
    expect(screen.getByText(/50% OFF/)).toBeInTheDocument();
  });

  it("isPopular=true renders the 'Most Popular' banner + indigo border", () => {
    const { container } = render(
      <PricingCard
        title="Pro"
        subtitle="x"
        price="999"
        isPopular
        features={BASIC_FEATURES}
      />
    );
    expect(screen.getByText(/most popular/i)).toBeInTheDocument();
    // The outer wrapper picks up the indigo ring + border-2 class set.
    expect((container.firstChild as HTMLElement).className).toMatch(/border-primary-600/);
  });

  it("onButtonClick present → renders a <button> that fires the callback", async () => {
    const user = userEvent.setup();
    const onButtonClick = vi.fn();
    render(
      <PricingCard
        title="Pro"
        subtitle="x"
        price="999"
        buttonText="Get Pro"
        onButtonClick={onButtonClick}
        features={BASIC_FEATURES}
      />
    );
    const btn = screen.getByRole("button", { name: /get pro/i });
    expect(btn.tagName).toBe("BUTTON");
    await user.click(btn);
    expect(onButtonClick).toHaveBeenCalledTimes(1);
    // No link with the same text — must be the button branch.
    expect(screen.queryByRole("link", { name: /get pro/i })).not.toBeInTheDocument();
  });

  it("no onButtonClick → renders a <Link> using buttonLink as the href", () => {
    render(
      <PricingCard
        title="Pro"
        subtitle="x"
        price="999"
        buttonText="Pick plan"
        buttonLink="/checkout?plan=pro"
        features={BASIC_FEATURES}
      />
    );
    const link = screen.getByRole("link", { name: /pick plan/i });
    expect(link).toHaveAttribute("href", "/checkout?plan=pro");
    expect(screen.queryByRole("button", { name: /pick plan/i })).not.toBeInTheDocument();
  });

  it("renders one row per feature with the appropriate text + gated highlight class", () => {
    render(
      <PricingCard
        title="Pro"
        subtitle="x"
        price="999"
        features={BASIC_FEATURES}
      />
    );
    expect(screen.getByText("Feature A")).toBeInTheDocument();
    expect(screen.getByText("Feature B (locked)")).toBeInTheDocument();
    // highlight=true picks up the bold/dark class
    const highlight = screen.getByText("Feature C (highlight)");
    expect(highlight.className).toMatch(/font-semibold/);
  });
});
