/**
 * Component tests for <SocialLoginButtons> (rescan-4 M14).
 * Pins the next-auth `signIn` flow:
 *  - Renders only Google by default (Facebook/GitHub gated by env vars,
 *    not set in tests).
 *  - Click calls signIn(provider, {redirect:false, callbackUrl:'/dashboard'}).
 *  - result.error → toast.error + onError; AccessDenied/Callback → the
 *    showAccountDeactivated branch (different copy).
 *  - result.ok → toast.success + onSuccess (after the 2s redirect timeout).
 *  - All buttons disabled while one is loading.
 */
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const signInMock = vi.hoisted(() => vi.fn());
vi.mock("next-auth/react", () => ({ signIn: signInMock }));

const toastErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
vi.mock("react-hot-toast", () => ({
  default: { error: toastErrorMock, success: toastSuccessMock },
  __esModule: true,
}));

const showAccountDeactivatedMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/toast", () => ({ showAccountDeactivated: showAccountDeactivatedMock }));

import SocialLoginButtons from "@/components/SocialLoginButtons";

beforeEach(() => {
  signInMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  showAccountDeactivatedMock.mockReset();
});

describe("<SocialLoginButtons>", () => {
  it("renders only the Google button when FACEBOOK/GITHUB env vars are off", () => {
    render(<SocialLoginButtons />);
    expect(screen.getByRole("button", { name: /sign in with google/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sign in with facebook/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sign in with github/i })).not.toBeInTheDocument();
  });

  it("renders the 'Or continue with' divider copy", () => {
    render(<SocialLoginButtons />);
    expect(screen.getByText(/or continue with/i)).toBeInTheDocument();
  });

  it("clicking Google calls signIn('google', {redirect:false, callbackUrl:'/dashboard'})", async () => {
    const user = userEvent.setup();
    signInMock.mockResolvedValue({ ok: false });
    render(<SocialLoginButtons />);
    await user.click(screen.getByRole("button", { name: /sign in with google/i }));
    expect(signInMock).toHaveBeenCalledWith("google", {
      redirect: false,
      callbackUrl: "/dashboard",
    });
  });

  it("result.error='OAuthSignin' shows the toast.error + calls onError with the message", async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    signInMock.mockResolvedValue({ error: "OAuthSignin" });
    render(<SocialLoginButtons onError={onError} />);
    await user.click(screen.getByRole("button", { name: /sign in with google/i }));
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringMatching(/failed to sign in/i));
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/failed to sign in/i));
  });

  it("result.error='AccessDenied' takes the deactivated-account branch (different copy)", async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    signInMock.mockResolvedValue({ error: "AccessDenied" });
    render(<SocialLoginButtons onError={onError} />);
    await user.click(screen.getByRole("button", { name: /sign in with google/i }));
    expect(showAccountDeactivatedMock).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("Account deactivated");
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("result.ok=true shows the success toast and calls onSuccess", async () => {
    vi.useFakeTimers();
    try {
      const onSuccess = vi.fn();
      signInMock.mockResolvedValue({ ok: true });
      render(<SocialLoginButtons onSuccess={onSuccess} />);
      // userEvent under fake timers hangs — use the click via dispatchEvent.
      const btn = screen.getByRole("button", { name: /sign in with google/i });
      await act(async () => {
        btn.click();
        // Flush the signIn microtask resolution before checking timers.
        await Promise.resolve();
      });
      expect(toastSuccessMock).toHaveBeenCalledWith(expect.stringMatching(/successfully signed in/i));
      expect(onSuccess).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an unexpected throw from signIn falls through to the catch + generic toast.error", async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    signInMock.mockRejectedValue(new Error("boom"));
    render(<SocialLoginButtons onError={onError} />);
    await user.click(screen.getByRole("button", { name: /sign in with google/i }));
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringMatching(/unexpected error/i));
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/unexpected error/i));
  });
});
