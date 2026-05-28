/**
 * Component tests for <HeroResultCard> + <CompactResultCard> (rescan-4 M14).
 * These are the leaf cards rendered by <SearchResults>. Tests pin the
 * available vs taken render forks, the badges and labels, the Intl en-IN
 * INR price formatting via the real useDomainPricing hook, the onAdd /
 * onWatch callbacks, the "SAVE N%" calculation on the compact card, and
 * the "Live Price" badge for `pricingSource === 'live'`.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import {
  HeroResultCard,
  CompactResultCard,
} from "@/components/domain-search/DomainCard";
import type { SearchResult } from "@/components/domain-search/hooks/useDomainSearch";

const available = (overrides: Partial<SearchResult> = {}): SearchResult => ({
  domainName: "example.com",
  available: true,
  price: 999,
  currency: "INR",
  registrationPeriod: 12,
  ...overrides,
} as SearchResult);

const taken = (overrides: Partial<SearchResult> = {}): SearchResult => ({
  domainName: "taken.com",
  available: false,
  registrationPeriod: 12,
  currency: "INR",
  ...overrides,
} as SearchResult);

describe("<HeroResultCard>", () => {
  it("renders the EXACT MATCH + BEST VALUE badges and 'Available to register' for an available domain", () => {
    render(<HeroResultCard result={available()} onAdd={vi.fn()} />);
    expect(screen.getByText(/exact match/i)).toBeInTheDocument();
    expect(screen.getByText(/best value/i)).toBeInTheDocument();
    expect(screen.getByText(/available to register/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "example.com" })).toBeInTheDocument();
  });

  it("renders the price + strike-through (price × 1.5) and fires onAdd on 'MAKE IT YOURS' click", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(<HeroResultCard result={available({ price: 999 })} onAdd={onAdd} />);
    // Strike-through original at 999 × 1.5 = 1499 → en-IN INR: "₹1,499"
    expect(screen.getByText("₹1,499")).toBeInTheDocument();
    // Main price "₹999"
    expect(screen.getByText("₹999")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /make it yours/i }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("renders TAKEN + 'Already registered' + disabled NOT AVAILABLE for a taken domain", () => {
    render(<HeroResultCard result={taken()} onAdd={vi.fn()} />);
    expect(screen.getByText(/^taken$/i)).toBeInTheDocument();
    expect(screen.getByText(/already registered/i)).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /not available/i });
    expect(btn).toBeDisabled();
  });

  it("renders the NOTIFY ME button when taken AND onWatch is provided, calling onWatch with the domain name", async () => {
    const user = userEvent.setup();
    const onWatch = vi.fn();
    render(<HeroResultCard result={taken({ domainName: "premium.com" })} onAdd={vi.fn()} onWatch={onWatch} />);
    await user.click(screen.getByRole("button", { name: /notify me/i }));
    expect(onWatch).toHaveBeenCalledWith("premium.com");
  });

  it("omits the NOTIFY ME button when taken but onWatch is not provided", () => {
    render(<HeroResultCard result={taken()} onAdd={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /notify me/i })).not.toBeInTheDocument();
  });
});

describe("<CompactResultCard>", () => {
  it("renders the domain name + 'Available' + 'BUY NOW' and fires onAdd", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(<CompactResultCard result={available({ domainName: "example.shop" })} onAdd={onAdd} />);
    expect(screen.getByText("example.shop")).toBeInTheDocument();
    expect(screen.getByText(/available/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /buy now/i }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("computes and renders the 'SAVE N%' badge from originalPrice", () => {
    // savings = round((1500 - 999) / 1500 * 100) = round(33.4) = 33
    render(
      <CompactResultCard
        result={available({ originalPrice: 1500, price: 999 } as Partial<SearchResult>)}
        onAdd={vi.fn()}
      />
    );
    expect(screen.getByText(/save 33%/i)).toBeInTheDocument();
    // The strike-through is the original price
    expect(screen.getByText("₹1,500")).toBeInTheDocument();
  });

  it("shows the 'Live Price' badge when pricingSource === 'live'", () => {
    render(
      <CompactResultCard
        result={available({ pricingSource: "live" } as Partial<SearchResult>)}
        onAdd={vi.fn()}
      />
    );
    expect(screen.getByText(/live price/i)).toBeInTheDocument();
  });

  it("renders 'Taken' + WATCH button on an unavailable result when onWatch is provided", async () => {
    const user = userEvent.setup();
    const onWatch = vi.fn();
    render(<CompactResultCard result={taken({ domainName: "gone.com" })} onAdd={vi.fn()} onWatch={onWatch} />);
    expect(screen.getByText(/taken/i)).toBeInTheDocument();
    expect(screen.getByText(/unavailable/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^watch$/i }));
    expect(onWatch).toHaveBeenCalledWith("gone.com");
  });

  it("renders a disabled N/A button when taken AND onWatch is not provided", () => {
    render(<CompactResultCard result={taken()} onAdd={vi.fn()} />);
    const btn = screen.getByRole("button", { name: /n\/a/i });
    expect(btn).toBeDisabled();
  });
});
