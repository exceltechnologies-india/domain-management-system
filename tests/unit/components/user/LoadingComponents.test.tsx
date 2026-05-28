/**
 * Component tests for <LoadingSpinner> / <PageLoading> / <DataLoading>
 * (rescan-4 M14). Small presentational shells used across user-facing
 * loading screens. Tests pin the message rendering, size→class mapping,
 * fullScreen wrapping, the page→message lookup with the 'content' fallback,
 * and the count+type routing on the DataLoading skeleton.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import {
  LoadingSpinner,
  PageLoading,
  DataLoading,
} from "@/components/user/LoadingComponents";

describe("<LoadingSpinner>", () => {
  it("renders the default 'Loading...' message and medium-size icon by default", () => {
    const { container } = render(<LoadingSpinner />);
    expect(screen.getByText("Loading...")).toBeInTheDocument();
    expect(container.querySelector(".h-8.w-8")).not.toBeNull();
  });

  it("honours a custom message", () => {
    render(<LoadingSpinner message="Crunching numbers..." />);
    expect(screen.getByText(/crunching numbers/i)).toBeInTheDocument();
  });

  it("maps size='lg' to the h-12 w-12 class", () => {
    const { container } = render(<LoadingSpinner size="lg" />);
    expect(container.querySelector(".h-12.w-12")).not.toBeNull();
  });

  it("wraps in a min-h-screen container under fullScreen={true}", () => {
    const { container } = render(<LoadingSpinner fullScreen />);
    expect(container.querySelector(".min-h-screen")).not.toBeNull();
  });

  it("uses the py-12 inline container when fullScreen is omitted", () => {
    const { container } = render(<LoadingSpinner />);
    expect(container.querySelector(".min-h-screen")).toBeNull();
    expect(container.querySelector(".py-12")).not.toBeNull();
  });
});

describe("<PageLoading>", () => {
  it("renders 'Loading...' (content fallback) when no `page` prop is supplied", () => {
    render(<PageLoading />);
    expect(screen.getByText(/^loading\.\.\.$/i)).toBeInTheDocument();
  });

  it("looks the message up by page key (domains → 'Loading your domains...')", () => {
    render(<PageLoading page="domains" />);
    expect(screen.getByText(/loading your domains/i)).toBeInTheDocument();
  });

  it("looks the message up by page key (orders → 'Loading your orders...')", () => {
    render(<PageLoading page="orders" />);
    expect(screen.getByText(/loading your orders/i)).toBeInTheDocument();
  });

  it("falls back to the generic 'Loading...' for an unknown page key", () => {
    render(<PageLoading page="some-random-key" />);
    expect(screen.getByText(/^loading\.\.\.$/i)).toBeInTheDocument();
  });

  it("includes the 'Please wait while we fetch your data' subline", () => {
    render(<PageLoading page="settings" />);
    expect(screen.getByText(/please wait while we fetch your data/i)).toBeInTheDocument();
  });
});

describe("<DataLoading>", () => {
  it("renders the requested number of skeleton blocks for the 'table' type", () => {
    const { container } = render(<DataLoading type="table" count={5} />);
    // Each row is a flex container with 4 animate-pulse children — count the rows
    const rows = container.querySelectorAll(".flex.space-x-4");
    expect(rows.length).toBe(5);
  });

  it("renders a card grid under type='card'", () => {
    const { container } = render(<DataLoading type="card" count={2} />);
    // The grid wrapper carries `grid gap-4 md:grid-cols-2 lg:grid-cols-3`
    expect(container.querySelector(".grid")).not.toBeNull();
    // Each card is a bg-white rounded-lg shadow-sm
    const cards = container.querySelectorAll(".bg-white.rounded-lg");
    expect(cards.length).toBe(2);
  });

  it("renders a list under type='list' with the requested count of rows", () => {
    const { container } = render(<DataLoading type="list" count={4} />);
    const rows = container.querySelectorAll(".bg-white.rounded-lg");
    expect(rows.length).toBe(4);
  });

  it("defaults to type='table' with count=3 when no props are supplied", () => {
    const { container } = render(<DataLoading />);
    const rows = container.querySelectorAll(".flex.space-x-4");
    expect(rows.length).toBe(3);
  });
});
