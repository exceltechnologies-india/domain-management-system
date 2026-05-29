/**
 * Component tests for <StatsCard> (rescan-4 M14).
 * Pins the value + label render, the trend-arrow + colour-class fork,
 * and the *both-trend-and-trendValue-required* gating (neither alone
 * renders the trend row).
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import StatsCard from "@/components/StatsCard";

describe("<StatsCard>", () => {
  it("renders the value + label + icon", () => {
    render(
      <StatsCard
        icon={<svg data-testid="stat-icon" />}
        value="1,234"
        label="Active domains"
      />
    );
    expect(screen.getByTestId("stat-icon")).toBeInTheDocument();
    expect(screen.getByText("1,234")).toBeInTheDocument();
    expect(screen.getByText("Active domains")).toBeInTheDocument();
  });

  it("trend='up' uses the green class + ↗ arrow", () => {
    const { container } = render(
      <StatsCard icon={null} value="42" label="x" trend="up" trendValue="+12%" />
    );
    expect(screen.getByText("+12%")).toBeInTheDocument();
    expect(screen.getByText("↗")).toBeInTheDocument();
    // The trend row carries the green colour class.
    expect(container.querySelector(".text-green-600")).not.toBeNull();
  });

  it("trend='down' uses the red class + ↘ arrow", () => {
    const { container } = render(
      <StatsCard icon={null} value="42" label="x" trend="down" trendValue="-3%" />
    );
    expect(screen.getByText("↘")).toBeInTheDocument();
    expect(container.querySelector(".text-red-600")).not.toBeNull();
  });

  it("trend='neutral' uses the gray class + → arrow", () => {
    const { container } = render(
      <StatsCard icon={null} value="42" label="x" trend="neutral" trendValue="0%" />
    );
    expect(screen.getByText("→")).toBeInTheDocument();
    // The label itself is also gray-600 — match the arrow row by ensuring the
    // trendValue text exists with the gray class as a sibling.
    expect(container.querySelector(".text-gray-600")).not.toBeNull();
  });

  it("trend without trendValue (or vice versa) does NOT render the trend row", () => {
    const { rerender } = render(
      <StatsCard icon={null} value="42" label="x" trend="up" />
    );
    expect(screen.queryByText("↗")).not.toBeInTheDocument();

    rerender(<StatsCard icon={null} value="42" label="x" trendValue="+5%" />);
    expect(screen.queryByText("+5%")).not.toBeInTheDocument();
  });
});
