/**
 * Component tests for <OrderTimeline> (rescan-4 M14).
 * Pins the conditional step assembly — Payment + Confirmation are always
 * present, Hosting is appended when hasHosting=true, Domain when
 * hasDomains=true. Also pins the userEmail interpolation and the
 * timing-label assignments per branch.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import OrderTimeline from "@/components/checkout/OrderTimeline";

describe("<OrderTimeline>", () => {
  it("with no domains/hosting renders only Payment + Confirmation (2 steps)", () => {
    const { container } = render(
      <OrderTimeline hasDomains={false} hasHosting={false} userEmail="a@b.com" />
    );
    const items = container.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(screen.getByText("Payment confirmed")).toBeInTheDocument();
    expect(screen.getByText("Confirmation email")).toBeInTheDocument();
    expect(screen.queryByText("Hosting account set up")).not.toBeInTheDocument();
    expect(screen.queryByText("Domain registered")).not.toBeInTheDocument();
  });

  it("hasHosting=true inserts the Hosting step with the 2-5 minutes timing", () => {
    render(
      <OrderTimeline hasDomains={false} hasHosting userEmail="a@b.com" />
    );
    expect(screen.getByText("Hosting account set up")).toBeInTheDocument();
    expect(screen.getByText("2–5 minutes")).toBeInTheDocument();
  });

  it("hasDomains=true inserts the Domain step with the 'Up to 24 hours' timing", () => {
    render(
      <OrderTimeline hasDomains hasHosting={false} userEmail="a@b.com" />
    );
    expect(screen.getByText("Domain registered")).toBeInTheDocument();
    expect(screen.getByText("Up to 24 hours")).toBeInTheDocument();
  });

  it("both flags renders all four steps in payment→hosting→domain→email order", () => {
    const { container } = render(
      <OrderTimeline hasDomains hasHosting userEmail="a@b.com" />
    );
    // Both the title and timing spans carry font-medium, so narrow to
    // the title spans by combining with text-sm (timing uses text-xs).
    const titles = Array.from(
      container.querySelectorAll("li span.text-sm.font-medium")
    ).map((el) => el.textContent);
    expect(titles).toEqual([
      "Payment confirmed",
      "Hosting account set up",
      "Domain registered",
      "Confirmation email",
    ]);
  });

  it("interpolates the user email into the confirmation step detail", () => {
    render(
      <OrderTimeline hasDomains={false} hasHosting={false} userEmail="user@example.test" />
    );
    expect(
      screen.getByText(/sent to user@example\.test/i)
    ).toBeInTheDocument();
  });
});
