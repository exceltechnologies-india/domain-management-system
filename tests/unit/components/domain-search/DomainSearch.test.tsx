/**
 * Component tests for the orchestrator `<DomainSearch>` (rescan-4 M14).
 * Subcomponents (SearchInput, SearchResults, DomainCard, the
 * DomainRequirementsModal) all have their own tests; here we focus on
 * the orchestration:
 *  - handleAddToCart routes to:
 *      • requirements modal if `requiresAdditionalDetails`
 *      • error toast if unsupported
 *      • cartStore.addItem + success toast + router.push('/cart') after 1s
 *  - missing required data → error toast (no cart write)
 *  - handleShowRequirements opens the requirements modal directly
 *  - handleWatch: 200 → success toast; 401 → sign-in prompt; 409 →
 *    'Already watching' toast; 400/default → error toast
 *  - sign-in prompt close, sign-in/register links carry returnUrl
 *
 * Mocks: useCartStore, useRouter, toast helpers, apiClient, the
 * useDomainSearch hook (so we control props rendered into SearchInput/
 * Results), domainRequirements helpers, and the SearchInput +
 * SearchResults + DomainRequirementsModal subcomponents — replaced with
 * thin stubs exposing the callbacks via test buttons.
 */
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Result<T> = { ok: true; data: T } | { ok: false; error: { status: number; message: string } };

const addItemMock = vi.hoisted(() => vi.fn());
vi.mock("@/store/cartStore", () => ({
  useCartStore: () => ({ addItem: addItemMock }),
}));

const pushMock = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

const successToast = vi.hoisted(() => vi.fn());
const errorToast = vi.hoisted(() => vi.fn());
vi.mock("@/lib/toast", () => ({
  showSuccessToast: successToast,
  showErrorToast: errorToast,
}));

const apiPostMock = vi.hoisted(() => vi.fn<(path: string, body?: unknown) => Promise<Result<unknown>>>());
vi.mock("@/lib/api-client", () => ({
  apiClient: { post: apiPostMock },
}));

const requiresAdditionalDetailsMock = vi.hoisted(() => vi.fn());
const isDomainSupportedMock = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/lib/domainRequirements", () => ({
  getDomainRequirements: () => ({ requirements: [], restrictions: [] }),
  requiresAdditionalDetails: requiresAdditionalDetailsMock,
  isDomainSupported: isDomainSupportedMock,
}));

const useDomainSearchMock = vi.hoisted(() =>
  vi.fn(() => ({
    searchTerm: "",
    isSearching: false,
    isLoadingSuggestions: false,
    results: [] as Array<{ domainName: string; price?: number; available?: boolean }>,
    hasSearched: false,
    error: null as string | null,
    baseDomain: "",
    searchMode: "default",
    isLoadingMore: false,
    canLoadMore: false,
    suggestions: [],
    handleSearch: vi.fn(),
    handleLoadMoreSuggestions: vi.fn(),
    handleInputChange: vi.fn(),
    clearSearch: vi.fn(),
  }))
);
vi.mock("@/components/domain-search/hooks/useDomainSearch", () => ({
  useDomainSearch: useDomainSearchMock,
}));

vi.mock("@/components/domain-search/SearchInput", () => ({
  default: () => <div data-testid="search-input" />,
}));

// SearchResults exposes the callbacks via test buttons so we can drive
// handleAddToCart / handleShowRequirements / handleWatch from the parent.
type SearchResultsProps = {
  onAddToCart: (r: { domainName: string; price?: number; available?: boolean; currency?: string; registrationPeriod?: number }) => void;
  onShowRequirements: (domain: string) => void;
  onWatch: (domain: string) => void;
};
const searchResultsMock = vi.hoisted(() =>
  vi.fn((props: SearchResultsProps) => (
    <div data-testid="search-results">
      <button
        onClick={() =>
          props.onAddToCart({
            domainName: "anutech.com",
            price: 999,
            available: true,
            currency: "INR",
            registrationPeriod: 1,
          })
        }
      >
        add-com
      </button>
      <button
        onClick={() =>
          props.onAddToCart({
            domainName: "anutech.au",
            price: 1500,
            available: true,
            currency: "INR",
          })
        }
      >
        add-au
      </button>
      <button
        onClick={() =>
          props.onAddToCart({
            domainName: "anutech.xyz",
            price: 99,
            available: true,
          })
        }
      >
        add-xyz
      </button>
      <button onClick={() => props.onAddToCart({ domainName: "missing.com" })}>
        add-missing
      </button>
      <button onClick={() => props.onShowRequirements("anutech.au")}>show-reqs</button>
      <button onClick={() => props.onWatch("taken.com")}>watch</button>
    </div>
  ))
);
vi.mock("@/components/domain-search/SearchResults", () => ({ default: searchResultsMock }));

const requirementsModalMock = vi.hoisted(() =>
  vi.fn(
    ({
      isOpen,
      domain,
      onClose,
    }: {
      isOpen: boolean;
      domain: string;
      onClose: () => void;
    }) =>
      isOpen ? (
        <div data-testid="reqs-modal" data-domain={domain}>
          <button onClick={onClose}>close-reqs</button>
        </div>
      ) : null
  )
);
vi.mock("@/components/DomainRequirementsModal", () => ({ default: requirementsModalMock }));

import DomainSearch from "@/components/domain-search/DomainSearch";

beforeEach(() => {
  addItemMock.mockReset();
  pushMock.mockReset();
  successToast.mockReset();
  errorToast.mockReset();
  apiPostMock.mockReset();
  requiresAdditionalDetailsMock.mockReset();
  requiresAdditionalDetailsMock.mockReturnValue(false);
  isDomainSupportedMock.mockReturnValue(true);
  searchResultsMock.mockClear();
  requirementsModalMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("<DomainSearch> orchestration", () => {
  it("renders the SearchInput + SearchResults + hero copy by default", () => {
    render(<DomainSearch />);
    expect(screen.getByTestId("search-input")).toBeInTheDocument();
    expect(screen.getByTestId("search-results")).toBeInTheDocument();
    expect(screen.getByText(/your perfect domain/i)).toBeInTheDocument();
  });

  it("showHeroText=false hides the hero heading", () => {
    render(<DomainSearch showHeroText={false} />);
    expect(screen.queryByText(/your perfect domain/i)).not.toBeInTheDocument();
  });

  it("addToCart on a standard domain → cartStore.addItem + success toast + 1s router.push('/cart')", async () => {
    const user = userEvent.setup();
    render(<DomainSearch />);
    await user.click(screen.getByText("add-com"));
    expect(addItemMock).toHaveBeenCalledWith(
      expect.objectContaining({
        domainName: "anutech.com",
        price: 999,
        currency: "INR",
        registrationPeriod: 1,
        itemType: "domain",
      })
    );
    expect(successToast).toHaveBeenCalledWith(expect.stringMatching(/anutech\.com added to cart/i));
    // 1s-delayed redirect — assert via a real-time wait.
    await new Promise((r) => setTimeout(r, 1100));
    expect(pushMock).toHaveBeenCalledWith("/cart");
  });

  it("addToCart on a requires-additional-details TLD → opens the requirements modal (no cart write)", async () => {
    const user = userEvent.setup();
    requiresAdditionalDetailsMock.mockReturnValue(true);
    render(<DomainSearch />);
    await user.click(screen.getByText("add-au"));
    expect(addItemMock).not.toHaveBeenCalled();
    const modal = screen.getByTestId("reqs-modal");
    expect(modal).toHaveAttribute("data-domain", "anutech");
  });

  it("addToCart on an unsupported domain → error toast (no cart write)", async () => {
    const user = userEvent.setup();
    isDomainSupportedMock.mockReturnValue(false);
    render(<DomainSearch />);
    await user.click(screen.getByText("add-com"));
    expect(addItemMock).not.toHaveBeenCalled();
    expect(errorToast).toHaveBeenCalledWith(
      expect.stringMatching(/requires additional verification/i)
    );
  });

  it("addToCart with missing price/available → 'missing required data' error toast", async () => {
    const user = userEvent.setup();
    render(<DomainSearch />);
    await user.click(screen.getByText("add-missing"));
    expect(addItemMock).not.toHaveBeenCalled();
    expect(errorToast).toHaveBeenCalledWith(expect.stringMatching(/missing required data/i));
  });

  it("handleShowRequirements opens the modal directly", async () => {
    const user = userEvent.setup();
    render(<DomainSearch />);
    await user.click(screen.getByText("show-reqs"));
    expect(screen.getByTestId("reqs-modal")).toHaveAttribute("data-domain", "anutech");
  });

  it("requirements modal close button hides the modal", async () => {
    const user = userEvent.setup();
    render(<DomainSearch />);
    await user.click(screen.getByText("show-reqs"));
    expect(screen.getByTestId("reqs-modal")).toBeInTheDocument();
    await user.click(screen.getByText("close-reqs"));
    expect(screen.queryByTestId("reqs-modal")).not.toBeInTheDocument();
  });

  it("handleWatch 200 → success toast ('we'll email you when X becomes available')", async () => {
    const user = userEvent.setup();
    apiPostMock.mockResolvedValueOnce({ ok: true, data: {} });
    render(<DomainSearch />);
    await user.click(screen.getByText("watch"));
    expect(apiPostMock).toHaveBeenCalledWith("/api/v1/user/domains/watch", {
      domainName: "taken.com",
    });
    expect(successToast).toHaveBeenCalledWith(expect.stringMatching(/taken\.com becomes available/));
  });

  it("handleWatch 401 → opens the sign-in prompt modal (links carry returnUrl with the base domain)", async () => {
    const user = userEvent.setup();
    apiPostMock.mockResolvedValueOnce({
      ok: false,
      error: { status: 401, message: "Unauthenticated" },
    });
    render(<DomainSearch />);
    await user.click(screen.getByText("watch"));
    expect(screen.getByText(/get notified when it's free/i)).toBeInTheDocument();
    // Domain shown in prompt
    expect(screen.getByText("taken.com")).toBeInTheDocument();
    // Login link carries returnUrl with `q=taken` (the base domain before the dot).
    const signInLink = screen.getByRole("link", { name: /^sign in$/i });
    expect(signInLink.getAttribute("href")).toMatch(/^\/login\?returnUrl=/);
    expect(signInLink.getAttribute("href")).toContain(encodeURIComponent("/domains/search?q=taken"));
  });

  it("handleWatch 409 → 'Already watching' error toast (no sign-in prompt)", async () => {
    const user = userEvent.setup();
    apiPostMock.mockResolvedValueOnce({
      ok: false,
      error: { status: 409, message: "Already exists" },
    });
    render(<DomainSearch />);
    await user.click(screen.getByText("watch"));
    expect(errorToast).toHaveBeenCalledWith(expect.stringMatching(/already watching taken\.com/i));
    expect(screen.queryByText(/get notified when it's free/i)).not.toBeInTheDocument();
  });

  it("handleWatch 400 → error toast with server message", async () => {
    const user = userEvent.setup();
    apiPostMock.mockResolvedValueOnce({
      ok: false,
      error: { status: 400, message: "Domain is reserved" },
    });
    render(<DomainSearch />);
    await user.click(screen.getByText("watch"));
    expect(errorToast).toHaveBeenCalledWith("Domain is reserved");
  });

  it("handleWatch 500/unknown → generic 'Failed to watch domain' toast", async () => {
    const user = userEvent.setup();
    apiPostMock.mockResolvedValueOnce({
      ok: false,
      error: { status: 500, message: "Internal" },
    });
    render(<DomainSearch />);
    await user.click(screen.getByText("watch"));
    expect(errorToast).toHaveBeenCalledWith(expect.stringMatching(/failed to watch domain/i));
  });

  it("sign-in prompt sign-in + register anchors both carry the returnUrl", async () => {
    const user = userEvent.setup();
    apiPostMock.mockResolvedValueOnce({
      ok: false,
      error: { status: 401, message: "Unauthenticated" },
    });
    render(<DomainSearch />);
    await user.click(screen.getByText("watch"));
    expect(screen.getByRole("link", { name: /^sign in$/i }).getAttribute("href")).toContain(
      encodeURIComponent("/domains/search?q=taken")
    );
    expect(screen.getByRole("link", { name: /^create account$/i }).getAttribute("href")).toContain(
      encodeURIComponent("/domains/search?q=taken")
    );
  });
});
