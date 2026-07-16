/**
 * Hook tests for `useDomainSearch` (rescan-4 M14 — domain-search hooks).
 * The 342-line search-state hook + the validateDomainInput / getSuggestedTlds
 * pure helpers. Pins:
 *
 * validateDomainInput (pure):
 *  - 'example.com' → valid, base='example', suggestedTld='com'
 *  - 'example.co.uk' → valid, base='example', suggestedTld='co.uk'
 *  - 'example' (bare) → valid, base='example', suggestedTld=null
 *  - 'ab' (2 chars, valid regex) → valid
 *  - 'a' / 'foo!' → invalid with warning copy
 *  - Whitespace stripped before validation
 *
 * getSuggestedTlds: returns TOP_TLDS filtered through isRestrictedTLD,
 * capped at 20.
 *
 * useDomainSearch (state machine):
 *  - Initial state: searchTerm='' / isSearching=false / hasSearched=false
 *  - rehydrates from `domainSearchState` localStorage on mount
 *  - initialSearchTerm seeds the input; autoSearch=true triggers a search
 *    after 100ms
 *  - handleSearch with invalid input → toast.error + early return (no API)
 *  - handleSearch with bare 'example' → searches base + '.com' tld + sets
 *    multi-search state
 *  - handleSearch with redirectOnSearch=true → router.push(/domains/search?q=...)
 *  - handleSearch happy path: quick result → setResults; then Phase-2
 *    suggestions fetch
 *  - quick result 'restricted_tld' → setError + toast.error (no suggestions)
 *  - quick network error → 'Network error' toast
 *  - handleInputChange: bare → multi mode, 'example.com' → single mode,
 *    invalid → resets baseDomain
 *  - clearSearch resets all state
 */
import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const pushMock = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

const toastFn = vi.hoisted(() => {
  const fn = vi.fn() as ReturnType<typeof vi.fn> & {
    error: ReturnType<typeof vi.fn>;
    success: ReturnType<typeof vi.fn>;
  };
  fn.error = vi.fn();
  fn.success = vi.fn();
  return fn;
});
vi.mock("react-hot-toast", () => ({
  default: toastFn,
  __esModule: true,
}));

const lsStore = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/storage", () => ({
  safeLocalStorage: {
    getItem: (k: string) => lsStore.get(k) ?? null,
    setItem: (k: string, v: string) => lsStore.set(k, v),
    removeItem: (k: string) => lsStore.delete(k),
  },
}));

const isRestrictedMock = vi.hoisted(() => vi.fn<(tld: string) => boolean>(() => false));
vi.mock("@/lib/domainRequirements", () => ({
  isRestrictedTLD: isRestrictedMock,
}));

type Result<T> = { ok: true; data: T } | { ok: false; error: { status: number; message: string } };
const apiPostMock = vi.hoisted(() =>
  vi.fn<(path: string, body: unknown) => Promise<Result<unknown>>>()
);
vi.mock("@/lib/api-client", () => ({
  apiClient: { post: apiPostMock },
}));

vi.mock("@/components/domain-search/data/tlds", () => ({
  TOP_TLDS: [".com", ".in", ".net", ".org", ".io", ".co", ".dev", ".app"],
}));

import {
  useDomainSearch,
  validateDomainInput,
  getSuggestedTlds,
} from "@/components/domain-search/hooks/useDomainSearch";

beforeEach(() => {
  pushMock.mockReset();
  toastFn.mockReset();
  toastFn.error.mockReset();
  toastFn.success.mockReset();
  lsStore.clear();
  isRestrictedMock.mockImplementation(() => false);
  apiPostMock.mockReset();
});

describe("validateDomainInput (pure)", () => {
  it("'example.com' → valid + base='example' + suggestedTld='com'", () => {
    const r = validateDomainInput("example.com");
    expect(r.isValid).toBe(true);
    if (r.isValid) {
      expect(r.baseDomain).toBe("example");
      expect(r.suggestedTld).toBe("com");
    }
  });

  it("'example.co.uk' → valid + base='example' + suggestedTld='co.uk'", () => {
    const r = validateDomainInput("example.co.uk");
    expect(r.isValid).toBe(true);
    if (r.isValid) {
      expect(r.baseDomain).toBe("example");
      expect(r.suggestedTld).toBe("co.uk");
    }
  });

  it("bare 'example' → valid + suggestedTld=null", () => {
    const r = validateDomainInput("example");
    expect(r.isValid).toBe(true);
    if (r.isValid) {
      expect(r.baseDomain).toBe("example");
      expect(r.suggestedTld).toBeNull();
    }
  });

  it("'ab' (2 chars) → valid (matches regex + ≥2 length)", () => {
    const r = validateDomainInput("ab");
    expect(r.isValid).toBe(true);
  });

  it("single 'a' → invalid", () => {
    const r = validateDomainInput("a");
    expect(r.isValid).toBe(false);
    if (!r.isValid) expect(r.warning).toMatch(/valid domain name/i);
  });

  it("'foo!' (special char) → invalid", () => {
    expect(validateDomainInput("foo!").isValid).toBe(false);
  });

  it("strips whitespace before validation: '  example  .com ' → valid", () => {
    const r = validateDomainInput("  example  .com ");
    expect(r.isValid).toBe(true);
    if (r.isValid) {
      expect(r.baseDomain).toBe("example");
      expect(r.suggestedTld).toBe("com");
    }
  });
});

describe("getSuggestedTlds", () => {
  it("returns the TOP_TLDS filtered through isRestrictedTLD, capped at 20", () => {
    isRestrictedMock.mockReturnValue(false);
    const out = getSuggestedTlds("example");
    expect(out).toEqual([".com", ".in", ".net", ".org", ".io", ".co", ".dev", ".app"]);
  });

  it("isRestrictedTLD=true filters that entry out", () => {
    isRestrictedMock.mockImplementation((tld: string) => tld === ".io");
    const out = getSuggestedTlds("example");
    expect(out).not.toContain(".io");
    expect(out).toContain(".com");
  });
});

describe("useDomainSearch", () => {
  it("initial state: empty search + not searching + nothing searched yet", () => {
    const { result } = renderHook(() => useDomainSearch({}));
    expect(result.current.searchTerm).toBe("");
    expect(result.current.isSearching).toBe(false);
    expect(result.current.hasSearched).toBe(false);
    expect(result.current.results).toEqual([]);
  });

  it("initialSearchTerm seeds the input + (autoSearch=true) triggers a search after 100ms", async () => {
    apiPostMock.mockResolvedValue({
      ok: true,
      data: { success: true, results: [{ domainName: "example.com", available: true }] },
    });
    const { result } = renderHook(() =>
      useDomainSearch({ initialSearchTerm: "example", autoSearch: true })
    );
    expect(result.current.searchTerm).toBe("example");
    await waitFor(() => expect(apiPostMock).toHaveBeenCalled(), { timeout: 1000 });
  });

  it("rehydrates from `domainSearchState` localStorage on mount", () => {
    lsStore.set(
      "domainSearchState",
      JSON.stringify({ searchTerm: "saved", baseDomain: "saved", searchMode: "multiple" })
    );
    const { result } = renderHook(() => useDomainSearch({}));
    expect(result.current.searchTerm).toBe("saved");
    expect(result.current.baseDomain).toBe("saved");
    expect(result.current.searchMode).toBe("multiple");
  });

  it("handleSearch with invalid input → toast.error + no API call", async () => {
    const { result } = renderHook(() => useDomainSearch({}));
    await act(async () => {
      await result.current.handleSearch(undefined, "!@#");
    });
    expect(toastFn.error).toHaveBeenCalledWith(expect.stringMatching(/valid domain name/i));
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("redirectOnSearch=true → router.push instead of fetching", async () => {
    const { result } = renderHook(() => useDomainSearch({ redirectOnSearch: true }));
    await act(async () => {
      result.current.handleInputChange({
        target: { value: "example" },
      } as React.ChangeEvent<HTMLInputElement>);
    });
    await act(async () => {
      await result.current.handleSearch();
    });
    expect(pushMock).toHaveBeenCalledWith(expect.stringContaining("/domains/search?q=example"));
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("handleSearch happy path: quick result → setResults + Phase-2 suggestions fetch", async () => {
    apiPostMock
      .mockResolvedValueOnce({
        ok: true,
        data: { success: true, results: [{ domainName: "example.com", available: true }] },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { success: true, suggestions: [{ domainName: "example.in", available: true }] },
      });
    const { result } = renderHook(() => useDomainSearch({}));
    await act(async () => {
      result.current.handleInputChange({
        target: { value: "example" },
      } as React.ChangeEvent<HTMLInputElement>);
    });
    await act(async () => {
      await result.current.handleSearch();
    });
    await waitFor(() => expect(result.current.results).toHaveLength(1));
    expect(result.current.results[0].domainName).toBe("example.com");
    expect(result.current.hasSearched).toBe(true);
    expect(apiPostMock).toHaveBeenCalledTimes(2); // quick + full
    await waitFor(() => expect(result.current.suggestions).toHaveLength(1));
  });

  it("quick result 'restricted_tld' → error state + toast.error (no suggestions fetch)", async () => {
    apiPostMock.mockResolvedValueOnce({
      ok: true,
      data: { success: false, error: "restricted_tld", message: "This TLD requires verification" },
    });
    const { result } = renderHook(() => useDomainSearch({}));
    await act(async () => {
      result.current.handleInputChange({
        target: { value: "example.au" },
      } as React.ChangeEvent<HTMLInputElement>);
    });
    await act(async () => {
      await result.current.handleSearch();
    });
    expect(result.current.error).toBe("This TLD requires verification");
    expect(toastFn.error).toHaveBeenCalledWith(
      "This TLD requires verification",
      expect.any(Object)
    );
    // Only the quick call — suggestions NOT fetched after a quick error.
    expect(apiPostMock).toHaveBeenCalledTimes(1);
  });

  it("quick network error → 'Network error' toast + error state", async () => {
    apiPostMock.mockResolvedValueOnce({
      ok: false,
      error: { status: 0, message: "network down" },
    });
    const { result } = renderHook(() => useDomainSearch({}));
    await act(async () => {
      result.current.handleInputChange({
        target: { value: "example.com" },
      } as React.ChangeEvent<HTMLInputElement>);
    });
    await act(async () => {
      await result.current.handleSearch();
    });
    expect(result.current.error).toMatch(/network error/i);
    expect(toastFn.error).toHaveBeenCalledWith(expect.stringMatching(/network error/i));
  });

  it("quick SERVER error (non-network, e.g. 400) → surfaces the server message, not 'Network error'", async () => {
    apiPostMock.mockResolvedValueOnce({
      ok: false,
      error: { status: 400, message: "Domain name is too short" },
    });
    const { result } = renderHook(() => useDomainSearch({}));
    await act(async () => {
      result.current.handleInputChange({
        target: { value: "example.com" },
      } as React.ChangeEvent<HTMLInputElement>);
    });
    await act(async () => {
      await result.current.handleSearch();
    });
    expect(result.current.error).toBe("Domain name is too short");
    expect(result.current.error).not.toMatch(/network error/i);
  });

  it("handleInputChange: 'example' (bare) → searchMode='multiple', baseDomain='example'", () => {
    const { result } = renderHook(() => useDomainSearch({}));
    act(() => {
      result.current.handleInputChange({
        target: { value: "example" },
      } as React.ChangeEvent<HTMLInputElement>);
    });
    expect(result.current.searchMode).toBe("multiple");
    expect(result.current.baseDomain).toBe("example");
  });

  it("handleInputChange: 'example.com' → searchMode='single', baseDomain='example'", () => {
    const { result } = renderHook(() => useDomainSearch({}));
    act(() => {
      result.current.handleInputChange({
        target: { value: "example.com" },
      } as React.ChangeEvent<HTMLInputElement>);
    });
    expect(result.current.searchMode).toBe("single");
    expect(result.current.baseDomain).toBe("example");
  });

  it("handleInputChange: invalid input resets baseDomain to ''", () => {
    const { result } = renderHook(() => useDomainSearch({}));
    act(() => {
      result.current.handleInputChange({
        target: { value: "!@#" },
      } as React.ChangeEvent<HTMLInputElement>);
    });
    expect(result.current.baseDomain).toBe("");
  });

  it("clearSearch resets all state", async () => {
    apiPostMock.mockResolvedValue({
      ok: true,
      data: { success: true, results: [{ domainName: "example.com", available: true }] },
    });
    const { result } = renderHook(() => useDomainSearch({}));
    await act(async () => {
      result.current.handleInputChange({
        target: { value: "example.com" },
      } as React.ChangeEvent<HTMLInputElement>);
    });
    await act(async () => {
      await result.current.handleSearch();
    });
    expect(result.current.hasSearched).toBe(true);
    act(() => {
      result.current.clearSearch();
    });
    expect(result.current.searchTerm).toBe("");
    expect(result.current.hasSearched).toBe(false);
    expect(result.current.results).toEqual([]);
    expect(result.current.baseDomain).toBe("");
    expect(result.current.canLoadMore).toBe(false);
  });
});
