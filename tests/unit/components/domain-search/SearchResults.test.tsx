/**
 * Component tests for <SearchResults> (rescan-4 M14).
 * The component composes HeroResultCard / CompactResultCard children from
 * ./DomainCard — those are mocked here as deterministic stubs so the test
 * focuses on SearchResults' own orchestration:
 *   - the AnimatePresence gate (no render until isSearching || hasSearched)
 *   - the loading splash, the "Exact Match Results" + "Other Popular
 *     Extensions" sections, the inline error, the suggestions skeleton,
 *     the suggestions grid with category-tab filtering, the Load More
 *     button + loading state, and the Clear Search callback.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import type { SearchResult } from "@/components/domain-search/hooks/useDomainSearch";

vi.mock("@/components/domain-search/DomainCard", () => ({
  HeroResultCard: ({ result, onAdd }: { result: SearchResult; onAdd: () => void }) => (
    <div data-testid="hero-card">
      <span>HERO: {result.domainName}</span>
      <button onClick={onAdd}>add-hero</button>
    </div>
  ),
  CompactResultCard: ({ result, onAdd }: { result: SearchResult; onAdd: () => void }) => (
    <div data-testid="compact-card">
      <span>COMPACT: {result.domainName}</span>
      <button onClick={onAdd}>add-{result.domainName}</button>
    </div>
  ),
}));

import SearchResults from "@/components/domain-search/SearchResults";

const result = (domainName: string, category?: string): SearchResult => ({
  domainName,
  available: true,
  price: 999,
  currency: "INR",
  registrationPeriod: 12,
  category,
} as SearchResult);

function defaults(overrides: Partial<React.ComponentProps<typeof SearchResults>> = {}) {
  return {
    isSearching: false,
    isLoadingSuggestions: false,
    hasSearched: false,
    results: [],
    suggestions: [],
    error: null,
    canLoadMore: false,
    isLoadingMore: false,
    onAddToCart: vi.fn(),
    onShowRequirements: vi.fn(),
    onClearSearch: vi.fn(),
    onLoadMore: vi.fn(),
    onWatch: vi.fn(),
    ...overrides,
  };
}

describe("<SearchResults>", () => {
  it("renders nothing before a search has started", () => {
    const { container } = render(<SearchResults {...defaults()} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the 'Analyzing Availability' splash while isSearching", () => {
    render(<SearchResults {...defaults({ isSearching: true })} />);
    expect(screen.getByRole("heading", { name: /analyzing availability/i })).toBeInTheDocument();
  });

  it("renders the HeroResultCard for the first result and CompactResultCards for the rest", () => {
    render(
      <SearchResults
        {...defaults({
          hasSearched: true,
          results: [result("example.com"), result("example.net"), result("example.io")],
        })}
      />
    );
    expect(screen.getByText(/hero: example\.com/i)).toBeInTheDocument();
    expect(screen.getByText(/other popular extensions/i)).toBeInTheDocument();
    expect(screen.getByText(/compact: example\.net/i)).toBeInTheDocument();
    expect(screen.getByText(/compact: example\.io/i)).toBeInTheDocument();
  });

  it("omits the 'Other Popular Extensions' section when only the hero result exists", () => {
    render(
      <SearchResults {...defaults({ hasSearched: true, results: [result("example.com")] })} />
    );
    expect(screen.getByText(/hero: example\.com/i)).toBeInTheDocument();
    expect(screen.queryByText(/other popular extensions/i)).not.toBeInTheDocument();
  });

  it("surfaces the inline error banner", () => {
    render(
      <SearchResults {...defaults({ hasSearched: true, error: "Restricted TLD" })} />
    );
    expect(screen.getByText("Restricted TLD")).toBeInTheDocument();
  });

  it("fires onClearSearch when Clear Search is clicked", async () => {
    const user = userEvent.setup();
    const onClearSearch = vi.fn();
    render(
      <SearchResults
        {...defaults({ hasSearched: true, results: [result("example.com")], onClearSearch })}
      />
    );
    await user.click(screen.getByRole("button", { name: /clear search/i }));
    expect(onClearSearch).toHaveBeenCalledTimes(1);
  });

  it("renders the suggestions skeleton while isLoadingSuggestions is true and suggestions is empty", () => {
    const { container } = render(
      <SearchResults
        {...defaults({
          hasSearched: true,
          results: [result("example.com")],
          isLoadingSuggestions: true,
        })}
      />
    );
    // The skeleton placeholder shells use animate-pulse — count the pulse-roles
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });

  it("filters suggestions by the active category tab (default 'All' shows everything)", async () => {
    const user = userEvent.setup();
    render(
      <SearchResults
        {...defaults({
          hasSearched: true,
          results: [result("example.com")],
          suggestions: [
            result("example.shop", "Popular"),
            result("example.tech", "Tech"),
            result("example.biz", "Business"),
          ],
        })}
      />
    );
    // All three suggestions visible under the default 'All' tab
    expect(screen.getByText(/compact: example\.shop/i)).toBeInTheDocument();
    expect(screen.getByText(/compact: example\.tech/i)).toBeInTheDocument();
    expect(screen.getByText(/compact: example\.biz/i)).toBeInTheDocument();

    // Switching to Tech narrows to the .tech entry
    await user.click(screen.getByRole("button", { name: /^Tech$/i }));
    expect(screen.getByText(/compact: example\.tech/i)).toBeInTheDocument();
    expect(screen.queryByText(/compact: example\.shop/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/compact: example\.biz/i)).not.toBeInTheDocument();
  });

  it("renders the 'Explore More Extensions' button when canLoadMore is true and fires onLoadMore on click", async () => {
    const user = userEvent.setup();
    const onLoadMore = vi.fn();
    render(
      <SearchResults
        {...defaults({
          hasSearched: true,
          results: [result("example.com")],
          canLoadMore: true,
          onLoadMore,
        })}
      />
    );
    const btn = screen.getByRole("button", { name: /explore more extensions/i });
    await user.click(btn);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("swaps the Load More button to 'Loading More...' + disabled while isLoadingMore is true", () => {
    render(
      <SearchResults
        {...defaults({
          hasSearched: true,
          results: [result("example.com")],
          canLoadMore: true,
          isLoadingMore: true,
        })}
      />
    );
    const btn = screen.getByRole("button", { name: /loading more/i });
    expect(btn).toBeDisabled();
  });
});
