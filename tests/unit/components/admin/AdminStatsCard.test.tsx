/**
 * Component tests for <AdminStatsCard> (rescan-4 M14).
 * Pins the title + value render, the optional change panel with its
 * type-driven icon (TrendingUp / TrendingDown / none for 'neutral') +
 * coloured text, and the colour-variant icon background.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { TrendingUp as TrendingUpIcon, Users } from "lucide-react";
import AdminStatsCard from "@/components/admin/AdminStatsCard";

describe("<AdminStatsCard>", () => {
  it("renders the title and value", () => {
    render(<AdminStatsCard title="Active Users" value={1234} icon={Users} />);
    expect(screen.getByText("Active Users")).toBeInTheDocument();
    expect(screen.getByText("1234")).toBeInTheDocument();
  });

  it("renders an increase change with the TrendingUp icon and green text + 'vs last month' suffix", () => {
    const { container } = render(
      <AdminStatsCard
        title="Revenue"
        value="₹1.2L"
        icon={Users}
        change={{ value: "+12%", type: "increase" }}
      />
    );
    expect(screen.getByText("+12%")).toBeInTheDocument();
    expect(screen.getByText(/vs last month/i)).toBeInTheDocument();
    // Inside the change panel, the green TrendingUp icon
    expect(container.querySelector(".text-green-500")).not.toBeNull();
    // The change value text is green-600
    expect(screen.getByText("+12%").className).toMatch(/text-green-600/);
  });

  it("renders a decrease change with TrendingDown icon and red text", () => {
    const { container } = render(
      <AdminStatsCard
        title="Errors"
        value={42}
        icon={Users}
        change={{ value: "-5%", type: "decrease" }}
      />
    );
    expect(screen.getByText("-5%")).toBeInTheDocument();
    expect(container.querySelector(".text-red-500")).not.toBeNull();
    expect(screen.getByText("-5%").className).toMatch(/text-red-600/);
  });

  it("renders a neutral change with NO trend icon but still shows the value + 'vs last month'", () => {
    const { container } = render(
      <AdminStatsCard
        title="Steady"
        value={50}
        icon={Users}
        change={{ value: "0%", type: "neutral" }}
      />
    );
    expect(screen.getByText("0%")).toBeInTheDocument();
    expect(screen.getByText(/vs last month/i)).toBeInTheDocument();
    // No TrendingUp/TrendingDown — both icons are filtered out for 'neutral'
    expect(container.querySelector(".text-green-500")).toBeNull();
    expect(container.querySelector(".text-red-500")).toBeNull();
  });

  it("hides the change panel entirely when no `change` prop is supplied", () => {
    render(<AdminStatsCard title="Plain" value={1} icon={Users} />);
    expect(screen.queryByText(/vs last month/i)).not.toBeInTheDocument();
  });

  it("applies the colour-variant icon background (purple → bg-purple-50)", () => {
    const { container } = render(
      <AdminStatsCard title="Purple" value={1} icon={Users} color="purple" />
    );
    // The icon wrapper carries the light bg class for the variant
    expect(container.querySelector(".bg-purple-50")).not.toBeNull();
  });

  it("defaults to blue when no colour is supplied", () => {
    const { container } = render(<AdminStatsCard title="Blue" value={1} icon={TrendingUpIcon} />);
    expect(container.querySelector(".bg-blue-50")).not.toBeNull();
  });
});
