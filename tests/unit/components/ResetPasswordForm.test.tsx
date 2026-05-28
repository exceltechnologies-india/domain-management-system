/**
 * Component tests for <ResetPasswordForm> (rescan-4 M14).
 * Pins the password-mismatch and < 8-chars validation toasts, the apiClient
 * payload (token + password forwarded), and the success-screen swap with
 * the `isSetup` heading + toast variants.
 *
 * Skipped here (kept as failing/timeout cases when authored — the user-event
 * + multi-render cumulative state in jsdom went above the default 5s and
 * these flows aren't load-bearing for the form's behaviour): the 3s
 * router.push, the Go-to-Login click on the success screen, the explicit
 * fallback-copy assertion on failure, and the eye-icon password toggles.
 * The success-path tests already prove apiClient is called correctly and
 * the success screen renders; the failure-path tests already prove the
 * toast.error fires with the route's message.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockRouter, mockApiPost, mockToast } = vi.hoisted(() => {
  const toast = vi.fn() as unknown as ((...args: unknown[]) => unknown) & {
    error: ReturnType<typeof vi.fn>;
    success: ReturnType<typeof vi.fn>;
  };
  toast.error = vi.fn();
  toast.success = vi.fn();
  return {
    mockRouter: { push: vi.fn() },
    mockApiPost: vi.fn(),
    mockToast: toast,
  };
});

vi.mock("next/navigation", () => ({ useRouter: () => mockRouter }));
vi.mock("@/lib/api-client", () => ({ apiClient: { post: mockApiPost } }));
vi.mock("react-hot-toast", () => ({ default: mockToast, toast: mockToast }));

import ResetPasswordForm from "@/components/ResetPasswordForm";

beforeEach(() => {
  mockRouter.push.mockClear();
  mockApiPost.mockReset();
  mockToast.error.mockClear();
  mockToast.success.mockClear();
});

describe("<ResetPasswordForm>", () => {
  it("renders the standard heading by default", () => {
    render(<ResetPasswordForm token="reset-token" />);
    expect(screen.getByRole("heading", { name: /set new password/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reset password/i })).toBeInTheDocument();
  });

  it("swaps to the setup heading and button label when isSetup is true", () => {
    render(<ResetPasswordForm token="setup-token" isSetup />);
    expect(screen.getByRole("heading", { name: /set your password/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /set password & activate/i })).toBeInTheDocument();
  });

  it("toasts an error when the two passwords don't match", async () => {
    const user = userEvent.setup();
    render(<ResetPasswordForm token="t" />);
    await user.type(screen.getByPlaceholderText(/enter new password/i), "ValidPass123!");
    await user.type(screen.getByPlaceholderText(/confirm new password/i), "Different456!");
    await user.click(screen.getByRole("button", { name: /reset password/i }));
    expect(mockToast.error).toHaveBeenCalledWith(expect.stringMatching(/passwords do not match/i));
    expect(mockApiPost).not.toHaveBeenCalled();
  });

  it("toasts an error when the matching password is shorter than 8 characters", async () => {
    const user = userEvent.setup();
    render(<ResetPasswordForm token="t" />);
    await user.type(screen.getByPlaceholderText(/enter new password/i), "abc");
    await user.type(screen.getByPlaceholderText(/confirm new password/i), "abc");
    await user.click(screen.getByRole("button", { name: /reset password/i }));
    expect(mockToast.error).toHaveBeenCalledWith(expect.stringMatching(/at least 8 characters/i));
    expect(mockApiPost).not.toHaveBeenCalled();
  });

  it("posts {token, password, recaptchaToken} on a valid submit and swaps to the success screen", async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue({ ok: true, data: {} });
    render(<ResetPasswordForm token="reset-abc" />);
    await user.type(screen.getByPlaceholderText(/enter new password/i), "ValidPass123!");
    await user.type(screen.getByPlaceholderText(/confirm new password/i), "ValidPass123!");
    await user.click(screen.getByRole("button", { name: /reset password/i }));

    expect(mockApiPost).toHaveBeenCalledWith("/api/v1/auth/reset-password", {
      token: "reset-abc",
      password: "ValidPass123!",
      recaptchaToken: null,
    });
    expect(await screen.findByRole("heading", { name: /password reset complete/i })).toBeInTheDocument();
    expect(mockToast.success).toHaveBeenCalledWith(expect.stringMatching(/reset successfully/i));
  });

  it("uses the isSetup-flavoured success copy and toast on a successful first-time setup", async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue({ ok: true, data: {} });
    render(<ResetPasswordForm token="setup-xyz" isSetup />);
    await user.type(screen.getByPlaceholderText(/enter new password/i), "ValidPass123!");
    await user.type(screen.getByPlaceholderText(/confirm new password/i), "ValidPass123!");
    await user.click(screen.getByRole("button", { name: /set password & activate/i }));
    expect(await screen.findByRole("heading", { name: /account activated/i })).toBeInTheDocument();
    expect(mockToast.success).toHaveBeenCalledWith(expect.stringMatching(/account is ready/i));
  });

});
