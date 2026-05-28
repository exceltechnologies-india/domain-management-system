/**
 * Component tests for <SearchInput> (rescan-4 M14).
 * Pins the value mirroring, onChange/onSearch callback wiring (button click
 * + Enter-key in container), the isSearching disable + spinner+label swap,
 * the empty/searching disable rules on the button, and the conditional
 * "We'll check .com, .net, .in and more for …" prompt that appears for
 * a multi-mode pending search.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import SearchInput from "@/components/domain-search/SearchInput";

function defaults(overrides: Partial<React.ComponentProps<typeof SearchInput>> = {}) {
  return {
    searchTerm: "",
    isSearching: false,
    searchMode: "single" as const,
    baseDomain: "",
    hasSearched: false,
    onChange: vi.fn(),
    onSearch: vi.fn(),
    ...overrides,
  };
}

describe("<SearchInput>", () => {
  it("renders the input mirroring searchTerm and a Search button", () => {
    render(<SearchInput {...defaults({ searchTerm: "example" })} />);
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("example");
    expect(screen.getByRole("button", { name: /search/i })).toBeInTheDocument();
  });

  it("disables the button while the search term is empty and re-enables once a value is present", () => {
    const { rerender } = render(<SearchInput {...defaults({ searchTerm: "" })} />);
    expect(screen.getByRole("button", { name: /search/i })).toBeDisabled();
    rerender(<SearchInput {...defaults({ searchTerm: "abc" })} />);
    expect(screen.getByRole("button", { name: /search/i })).not.toBeDisabled();
  });

  it("fires onChange for each keystroke", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SearchInput {...defaults({ onChange })} />);
    await user.type(screen.getByRole("textbox"), "abc");
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("fires onSearch on Search-button click", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(<SearchInput {...defaults({ searchTerm: "example", onSearch })} />);
    await user.click(screen.getByRole("button", { name: /search/i }));
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it("fires onSearch on Enter inside the input", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(<SearchInput {...defaults({ searchTerm: "example", onSearch })} />);
    await user.type(screen.getByRole("textbox"), "{Enter}");
    expect(onSearch).toHaveBeenCalled();
  });

  it("disables the input + button and swaps the button to the searching state while isSearching is true", () => {
    render(<SearchInput {...defaults({ searchTerm: "example", isSearching: true })} />);
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: /search/i })).toBeDisabled();
    expect(screen.getByText(/searching/i)).toBeInTheDocument();
  });

  it("shows the 'We'll check .com, .net, .in and more for …' prompt in multi mode with a baseDomain and no prior search", () => {
    render(
      <SearchInput {...defaults({ searchMode: "multiple", baseDomain: "myproject", hasSearched: false })} />
    );
    expect(screen.getByText(/we'll check \.com, \.net, \.in and more for "myproject"/i)).toBeInTheDocument();
  });

  it("suppresses the prompt once a search has happened (hasSearched=true)", () => {
    // Fresh mount so AnimatePresence has nothing to exit-animate
    render(
      <SearchInput {...defaults({ searchMode: "multiple", baseDomain: "myproject", hasSearched: true })} />
    );
    expect(screen.queryByText(/we'll check/i)).not.toBeInTheDocument();
  });

  it("suppresses the prompt in single mode", () => {
    render(
      <SearchInput {...defaults({ searchMode: "single", baseDomain: "myproject", hasSearched: false })} />
    );
    expect(screen.queryByText(/we'll check/i)).not.toBeInTheDocument();
  });
});
