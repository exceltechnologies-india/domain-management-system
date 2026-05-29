/**
 * Component tests for <CookieConsentBanner> (rescan-4 M14).
 * Pins the visibility gates:
 *  - Anonymous + no prior consent → banner appears.
 *  - Anonymous + prior consent → banner stays hidden.
 *  - Authenticated → auto-accept (sets localStorage, banner hidden).
 *  - Accept / dismiss buttons both persist 'accepted' + hide.
 */
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

type SessionMockReturn = { data: { user?: { name?: string } } | null } | undefined;
const useSessionMock = vi.hoisted(() =>
  vi.fn<() => SessionMockReturn>(() => ({ data: null }))
);
vi.mock("next-auth/react", () => ({
  useSession: useSessionMock,
}));

const safeLocalStorageStore = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/storage", () => ({
  safeLocalStorage: {
    getItem: (k: string) => safeLocalStorageStore.get(k) ?? null,
    setItem: (k: string, v: string) => {
      safeLocalStorageStore.set(k, v);
    },
    removeItem: (k: string) => {
      safeLocalStorageStore.delete(k);
    },
  },
}));

import CookieConsentBanner from "@/components/CookieConsentBanner";

beforeEach(() => {
  safeLocalStorageStore.clear();
  useSessionMock.mockReturnValue({ data: null });
});

describe("<CookieConsentBanner>", () => {
  it("shows the banner when anonymous and no consent is stored", () => {
    render(<CookieConsentBanner />);
    expect(screen.getByRole("dialog", { name: /cookie consent/i })).toBeInTheDocument();
    expect(screen.getByText(/we use essential cookies/i)).toBeInTheDocument();
  });

  it("stays hidden when consent is already stored", () => {
    safeLocalStorageStore.set("cookieConsent", "accepted");
    render(<CookieConsentBanner />);
    expect(screen.queryByRole("dialog", { name: /cookie consent/i })).not.toBeInTheDocument();
  });

  it("auto-accepts for authenticated users (writes to localStorage and stays hidden)", () => {
    useSessionMock.mockReturnValue({
      data: { user: { name: "Alice" } },
    });
    render(<CookieConsentBanner />);
    expect(screen.queryByRole("dialog", { name: /cookie consent/i })).not.toBeInTheDocument();
    expect(safeLocalStorageStore.get("cookieConsent")).toBe("accepted");
  });

  it("clicking 'Accept & Continue' hides the banner and persists consent", async () => {
    const user = userEvent.setup();
    render(<CookieConsentBanner />);
    await user.click(screen.getByRole("button", { name: /accept & continue/i }));
    expect(safeLocalStorageStore.get("cookieConsent")).toBe("accepted");
    expect(screen.queryByRole("dialog", { name: /cookie consent/i })).not.toBeInTheDocument();
  });

  it("clicking the dismiss (X) button also accepts and hides", async () => {
    const user = userEvent.setup();
    render(<CookieConsentBanner />);
    await user.click(screen.getByRole("button", { name: /dismiss cookie notice/i }));
    expect(safeLocalStorageStore.get("cookieConsent")).toBe("accepted");
    expect(screen.queryByRole("dialog", { name: /cookie consent/i })).not.toBeInTheDocument();
  });

  it("survives an undefined-session race (useSession returns undefined)", () => {
    // Defensive `sessionResult?.data` branch — happens during a hydration race.
    useSessionMock.mockReturnValue(undefined as unknown as { data: null });
    expect(() =>
      act(() => {
        render(<CookieConsentBanner />);
      })
    ).not.toThrow();
    // No session and no prior consent → banner appears
    expect(screen.getByRole("dialog", { name: /cookie consent/i })).toBeInTheDocument();
  });
});
