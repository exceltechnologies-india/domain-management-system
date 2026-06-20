/**
 * Component tests for <ForgotPasswordForm> (rescan-4 M14).
 * Pins the default vs isSetup heading + button-label swap, the prefilledEmail
 * pre-population (for the guest-conversion flow), the happy-path apiClient
 * payload + sent-screen swap with the email mirrored back at the user, and
 * the failure path (inline error bar + toast.error from the route's message).
 *
 * The 60s "Send Another Email" cooldown countdown is not asserted here —
 * it's time-driven UI that risks jsdom timeouts under cumulative user-event
 * state; the cooldown-start side-effect lives in the sent-screen render.
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

import ForgotPasswordForm from "@/components/ForgotPasswordForm";

beforeEach(() => {
  mockRouter.push.mockClear();
  mockApiPost.mockReset();
  mockToast.error.mockClear();
  mockToast.success.mockClear();
});

describe("<ForgotPasswordForm>", () => {
  it("renders the default 'Forgot your password?' heading + 'Send Reset Link' button", () => {
    render(<ForgotPasswordForm />);
    expect(screen.getByRole("heading", { name: /forgot your password/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send reset link/i })).toBeInTheDocument();
  });

  it("swaps to the setup-flavoured heading and button when isSetup is true", () => {
    render(<ForgotPasswordForm isSetup />);
    expect(screen.getByRole("heading", { name: /set up your password/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send setup link/i })).toBeInTheDocument();
  });

  it("pre-fills the email input from the prefilledEmail prop", () => {
    render(<ForgotPasswordForm prefilledEmail="guest@example.com" />);
    expect((screen.getByPlaceholderText(/enter your email address/i) as HTMLInputElement).value).toBe(
      "guest@example.com"
    );
  });

  it("posts {email} on submit and swaps to the sent-screen with the email mirrored back", async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue({ ok: true, data: {} });
    render(<ForgotPasswordForm />);

    await user.type(screen.getByPlaceholderText(/enter your email address/i), "alice@example.com");
    await user.click(screen.getByRole("button", { name: /send reset link/i }));

    expect(mockApiPost).toHaveBeenCalledWith("/api/v1/auth/forgot-password", {
      email: "alice@example.com",
      recaptchaToken: null,
    });
    expect(await screen.findByRole("heading", { name: /check your email/i })).toBeInTheDocument();
    expect(screen.getByText(/we've sent a password reset link to alice@example\.com/i)).toBeInTheDocument();
    expect(mockToast.success).toHaveBeenCalledWith(expect.stringMatching(/password reset email sent/i));
  });

  it("uses the setup-flavoured toast on the sent-screen for an isSetup submission", async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue({ ok: true, data: {} });
    render(<ForgotPasswordForm isSetup prefilledEmail="guest@example.com" />);

    await user.click(screen.getByRole("button", { name: /send setup link/i }));
    expect(await screen.findByText(/we've sent a setup link to guest@example\.com/i)).toBeInTheDocument();
    expect(mockToast.success).toHaveBeenCalledWith(expect.stringMatching(/setup link sent/i));
  });

  it("surfaces the route's error.message on failure (inline bar + toast)", async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue({ ok: false, error: { status: 429, message: "Too many requests" } });
    render(<ForgotPasswordForm />);

    await user.type(screen.getByPlaceholderText(/enter your email address/i), "alice@example.com");
    await user.click(screen.getByRole("button", { name: /send reset link/i }));

    await vi.waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("Too many requests"));
    // Inline error bar mirrors the same message; stays on the form (no swap).
    expect(screen.getByText("Too many requests")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /check your email/i })).not.toBeInTheDocument();
  });
});
