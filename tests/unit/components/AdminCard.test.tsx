/**
 * Component tests for <AdminCard> (rescan-4 M14).
 * Pins the title + value render, the icon being passed through, and the
 * three change-variant colour classes (positive→green / negative→red /
 * neutral→gray) + the no-change-prop hide.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Users } from "lucide-react";
import AdminCard from "@/components/AdminCard";

describe("<AdminCard>", () => {
  it("renders the title and value", () => {
    render(<AdminCard title="Active" value={42} icon={Users} />);
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("hides the change line when no `change` prop is supplied", () => {
    render(<AdminCard title="Active" value={42} icon={Users} />);
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it("applies the green class to a 'positive' change", () => {
    render(
      <AdminCard
        title="Revenue"
        value="₹1.2L"
        icon={Users}
        change={{ value: "+12%", type: "positive" }}
      />
    );
    expect(screen.getByText("+12%")).toHaveClass("text-green-600");
  });

  it("applies the red class to a 'negative' change", () => {
    render(
      <AdminCard
        title="Errors"
        value={5}
        icon={Users}
        change={{ value: "-3%", type: "negative" }}
      />
    );
    expect(screen.getByText("-3%")).toHaveClass("text-red-600");
  });

  it("applies the gray class to a 'neutral' change", () => {
    render(
      <AdminCard
        title="Flat"
        value={10}
        icon={Users}
        change={{ value: "0%", type: "neutral" }}
      />
    );
    expect(screen.getByText("0%")).toHaveClass("text-gray-600");
  });
});
