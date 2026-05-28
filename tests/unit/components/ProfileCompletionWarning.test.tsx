/**
 * Component tests for <ProfileCompletionWarning> (rescan-4 M14).
 * Pins the show/hide gating against the four user shapes (no user, complete,
 * missing phone only, missing address only, both missing), the session+local
 * merge precedence, the singular-vs-plural grammar of the missing-fields
 * sentence, the Complete-now redirect (with and without a returnUrl), the
 * Dismiss button hiding the warning, and the `profileUpdated` event-driven
 * re-check.
 */
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockRouter, mockUseSession, mockLocalStorage } = vi.hoisted(() => ({
  mockRouter: { push: vi.fn() },
  mockUseSession: vi.fn(),
  mockLocalStorage: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));

vi.mock("next/navigation", () => ({ useRouter: () => mockRouter }));
vi.mock("next-auth/react", () => ({ useSession: mockUseSession }));
vi.mock("@/lib/storage", () => ({ safeLocalStorage: mockLocalStorage }));

import ProfileCompletionWarning from "@/components/ProfileCompletionWarning";

const completeUser = {
  phone: "9999999999",
  phoneCc: "+91",
  address: { line1: "1 Some Road", city: "Mumbai", state: "MH", country: "IN", zipcode: "400001" },
  profileCompleted: true,
};

const sessionUser = (overrides: object = {}) => ({
  data: { user: { id: "u1", name: "Jane Doe", email: "jane@example.com", ...overrides } },
  status: "authenticated",
});

beforeEach(() => {
  mockRouter.push.mockClear();
  mockUseSession.mockReset();
  mockLocalStorage.getItem.mockReset();
  mockLocalStorage.getItem.mockReturnValue(null);
});

describe("<ProfileCompletionWarning>", () => {
  it("renders nothing when neither session nor localStorage has a user", () => {
    mockUseSession.mockReturnValue({ data: null, status: "unauthenticated" });
    const { container } = render(<ProfileCompletionWarning />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the user's profile is complete", () => {
    mockUseSession.mockReturnValue(sessionUser(completeUser));
    const { container } = render(<ProfileCompletionWarning />);
    expect(container.firstChild).toBeNull();
  });

  it("warns and uses plural grammar when both phone and address are missing", () => {
    mockUseSession.mockReturnValue(sessionUser({ profileCompleted: false }));
    render(<ProfileCompletionWarning />);
    expect(screen.getByText(/complete your profile to checkout/i)).toBeInTheDocument();
    // The bolded "phone number and address" sits inside a <strong> — the surrounding
    // sentence appears as separate text nodes; assert both halves.
    expect(screen.getByText(/phone number and address/i)).toBeInTheDocument();
    expect(screen.getByText(/are missing/i)).toBeInTheDocument();
  });

  it("uses singular grammar when only the phone is missing", () => {
    mockUseSession.mockReturnValue(
      sessionUser({
        profileCompleted: false,
        address: { line1: "1 Some Road" },
      })
    );
    render(<ProfileCompletionWarning />);
    expect(screen.getByText(/phone number/i)).toBeInTheDocument();
    expect(screen.queryByText(/and address/i)).not.toBeInTheDocument();
    expect(screen.getByText(/is missing/i)).toBeInTheDocument();
  });

  it("uses singular grammar when only the address is missing", () => {
    mockUseSession.mockReturnValue(
      sessionUser({ profileCompleted: false, phone: "9999999999", phoneCc: "+91" })
    );
    render(<ProfileCompletionWarning />);
    expect(screen.getByText("address")).toBeInTheDocument();
    expect(screen.getByText(/is missing/i)).toBeInTheDocument();
  });

  it("treats whitespace-only phone/address as missing (trim check)", () => {
    mockUseSession.mockReturnValue(
      sessionUser({ profileCompleted: false, phone: "   ", phoneCc: "+91", address: { line1: "   " } })
    );
    render(<ProfileCompletionWarning />);
    expect(screen.getByText(/phone number and address/i)).toBeInTheDocument();
  });

  it("merges session with localStorage — local overrides session fields", () => {
    // Session says profile is complete; localStorage says fields are missing.
    // The component spreads session first then local, so local wins → warning.
    mockUseSession.mockReturnValue(sessionUser(completeUser));
    mockLocalStorage.getItem.mockReturnValue(
      JSON.stringify({ profileCompleted: false, phone: "", phoneCc: "", address: { line1: "" } })
    );
    render(<ProfileCompletionWarning />);
    expect(screen.getByText(/complete your profile to checkout/i)).toBeInTheDocument();
  });

  it("uses localStorage as the user source when there's no session", () => {
    mockUseSession.mockReturnValue({ data: null, status: "unauthenticated" });
    mockLocalStorage.getItem.mockReturnValue(
      JSON.stringify({ profileCompleted: false, phone: "9999999999", phoneCc: "+91" })
    );
    render(<ProfileCompletionWarning />);
    expect(screen.getByText("address")).toBeInTheDocument();
  });

  it("routes to /dashboard/settings with the encoded returnUrl on Complete-now", async () => {
    const user = userEvent.setup();
    mockUseSession.mockReturnValue(sessionUser({ profileCompleted: false }));
    render(<ProfileCompletionWarning returnUrl="/cart" />);
    await user.click(screen.getByRole("button", { name: /complete now/i }));
    expect(mockRouter.push).toHaveBeenCalledWith("/dashboard/settings?returnUrl=%2Fcart");
  });

  it("routes to /dashboard/settings without a returnUrl query when none is provided", async () => {
    const user = userEvent.setup();
    mockUseSession.mockReturnValue(sessionUser({ profileCompleted: false }));
    render(<ProfileCompletionWarning />);
    await user.click(screen.getByRole("button", { name: /complete now/i }));
    expect(mockRouter.push).toHaveBeenCalledWith("/dashboard/settings");
  });

  it("Dismiss hides the warning for the remainder of the session", async () => {
    const user = userEvent.setup();
    mockUseSession.mockReturnValue(sessionUser({ profileCompleted: false }));
    render(<ProfileCompletionWarning />);
    expect(screen.getByText(/complete your profile to checkout/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByText(/complete your profile to checkout/i)).not.toBeInTheDocument();
  });

  it("re-evaluates on a profileUpdated event (warning disappears after the user fills in their profile)", () => {
    // Start with a missing profile so the warning is visible
    mockUseSession.mockReturnValue(sessionUser({ profileCompleted: false }));
    render(<ProfileCompletionWarning />);
    expect(screen.getByText(/complete your profile to checkout/i)).toBeInTheDocument();

    // Profile updated externally — localStorage now has a complete user; the
    // event handler re-runs checkUserProfile and the warning disappears.
    mockLocalStorage.getItem.mockReturnValue(JSON.stringify(completeUser));
    act(() => {
      window.dispatchEvent(new Event("profileUpdated"));
    });
    expect(screen.queryByText(/complete your profile to checkout/i)).not.toBeInTheDocument();
  });
});
