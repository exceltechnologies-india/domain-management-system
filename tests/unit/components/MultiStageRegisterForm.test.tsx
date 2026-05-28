/**
 * Component tests for <MultiStageRegisterForm> (rescan-4 M14).
 * Pins the client-side validation gate, the apiClient payload (firstName,
 * lastName, email, password — note `confirmPassword` is NOT forwarded),
 * the two success branches (requiresActivation → /login?message=… with
 * returnUrl appended, vs the plain /login redirect), the Zod field-error
 * tree from `result.error.body.details` mapped back onto per-field
 * inline errors, the toast.error fallback on generic failures, and the
 * returnUrl being read from the URL search params.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ReactNode } from "react";

const { mockRouter, mockSearchParams, mockApiPost, mockToast } = vi.hoisted(() => {
  const toast = vi.fn() as unknown as ((...args: unknown[]) => unknown) & {
    error: ReturnType<typeof vi.fn>;
    success: ReturnType<typeof vi.fn>;
  };
  toast.error = vi.fn();
  toast.success = vi.fn();
  return {
    mockRouter: { push: vi.fn() },
    mockSearchParams: { get: vi.fn() },
    mockApiPost: vi.fn(),
    mockToast: toast,
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => mockSearchParams,
}));
vi.mock("@/lib/api-client", () => ({ apiClient: { post: mockApiPost } }));
vi.mock("react-hot-toast", () => ({ default: mockToast, toast: mockToast }));
vi.mock("@/components/AuthShell", () => ({
  default: ({ title, children }: { title?: ReactNode; children: ReactNode }) => (
    <div>
      {title ? <h1>{title}</h1> : null}
      {children}
    </div>
  ),
}));
vi.mock("@/components/SocialLoginButtons", () => ({ default: () => null }));

import MultiStageRegisterForm from "@/components/MultiStageRegisterForm";

beforeEach(() => {
  mockRouter.push.mockClear();
  mockApiPost.mockReset();
  mockToast.error.mockClear();
  mockToast.success.mockClear();
  mockSearchParams.get.mockReset();
  mockSearchParams.get.mockReturnValue(null);
});

async function fillValid(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText(/first name/i), "Alice");
  await user.type(screen.getByPlaceholderText(/last name/i), "Smith");
  await user.type(screen.getByPlaceholderText("you@example.com"), "alice@example.com");
  // Password strength validator demands upper + lower + digit + special; keep it satisfied.
  await user.type(screen.getByPlaceholderText(/create a strong password/i), "ValidPass1!");
  await user.type(screen.getByPlaceholderText(/confirm your password/i), "ValidPass1!");
}

describe("<MultiStageRegisterForm>", () => {
  it("renders the heading + the five form fields", () => {
    render(<MultiStageRegisterForm />);
    expect(screen.getByRole("heading", { name: /create your account/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/first name/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/last name/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("you@example.com")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/create a strong password/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/confirm your password/i)).toBeInTheDocument();
  });

  it("shows inline errors and does NOT call the API when fields are empty", () => {
    const { container } = render(<MultiStageRegisterForm />);
    // HTML5 required would block a user.click; fireEvent.submit bypasses that
    // so we observe the component's own validate() logic running with empty
    // fields. (The component will still get this path in production if a
    // browser auto-fills, ships an Enter from a virtual keyboard, etc.)
    const form = container.querySelector("form");
    if (!form) throw new Error("form not found");
    fireEvent.submit(form);
    expect(mockApiPost).not.toHaveBeenCalled();
    expect(screen.getByText(/please confirm your password/i)).toBeInTheDocument();
  });

  it("flags 'Passwords do not match' on mismatched confirmPassword and skips the API call", async () => {
    const user = userEvent.setup();
    render(<MultiStageRegisterForm />);
    await user.type(screen.getByPlaceholderText(/first name/i), "Alice");
    await user.type(screen.getByPlaceholderText(/last name/i), "Smith");
    await user.type(screen.getByPlaceholderText("you@example.com"), "alice@example.com");
    await user.type(screen.getByPlaceholderText(/create a strong password/i), "ValidPass1!");
    await user.type(screen.getByPlaceholderText(/confirm your password/i), "DifferentPass1!");
    await user.click(screen.getByRole("button", { name: /create account/i }));
    expect(screen.getByText(/passwords do not match/i)).toBeInTheDocument();
    expect(mockApiPost).not.toHaveBeenCalled();
  });

  it("posts {firstName, lastName, email, password} (no confirmPassword) and redirects to /login on requiresActivation:false", async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue({ ok: true, data: { requiresActivation: false } });
    render(<MultiStageRegisterForm />);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(mockApiPost).toHaveBeenCalledWith("/api/v1/auth/register", {
      firstName: "Alice",
      lastName: "Smith",
      email: "alice@example.com",
      password: "ValidPass1!",
    });
    expect(mockToast.success).toHaveBeenCalledWith(expect.stringMatching(/account created/i));
    // The component's `returnUrl` falls back to "/dashboard" when no query
    // param is present, and the redirect always appends it — so a "no URL
    // returnUrl" submit still lands at /login?returnUrl=%2Fdashboard.
    // This pins the actual behaviour; bare `/login` would mean the fallback
    // logic changed.
    await vi.waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith("/login?returnUrl=%2Fdashboard"));
  });

  it("routes to /login?message=… on requiresActivation:true and appends returnUrl when present in the URL", async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue({ ok: true, data: { requiresActivation: true } });
    mockSearchParams.get.mockReturnValue("/cart");
    render(<MultiStageRegisterForm />);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await vi.waitFor(() => {
      const pushed = mockRouter.push.mock.calls[0][0] as string;
      expect(pushed).toMatch(/^\/login\?message=/);
      expect(pushed).toContain("returnUrl=%2Fcart");
    });
    expect(mockToast.success).toHaveBeenCalledWith(expect.stringMatching(/check your email/i));
  });

  it("maps the Zod field-error tree from result.error.body.details back onto per-field inline errors", async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue({
      ok: false,
      error: {
        status: 400,
        message: "Validation failed",
        body: {
          details: {
            email: { _errors: ["Email already in use"] },
            password: { _errors: ["Password too weak (server-side)"] },
          },
        },
      },
    });
    render(<MultiStageRegisterForm />);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByText(/email already in use/i)).toBeInTheDocument();
    expect(screen.getByText(/password too weak \(server-side\)/i)).toBeInTheDocument();
    // The generic top-level toast also fires
    expect(mockToast.error).toHaveBeenCalledWith("Validation failed");
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it("toasts the route's error.message when the failure has no Zod details", async () => {
    const user = userEvent.setup();
    mockApiPost.mockResolvedValue({
      ok: false,
      error: { status: 500, message: "Something went wrong", body: undefined },
    });
    render(<MultiStageRegisterForm />);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: /create account/i }));
    await vi.waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("Something went wrong"));
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it("clears the inline error for a field as soon as the user starts typing in it again", async () => {
    const user = userEvent.setup();
    const { container } = render(<MultiStageRegisterForm />);
    // Trigger validation via fireEvent.submit to bypass HTML5 required
    const form = container.querySelector("form");
    if (!form) throw new Error("form not found");
    fireEvent.submit(form);
    expect(screen.getByText(/please confirm your password/i)).toBeInTheDocument();
    // Typing in confirmPassword clears its error from state; framer-motion's
    // exit animation lingers in the DOM, so wait for the element to actually
    // be removed before asserting absence.
    await user.type(screen.getByPlaceholderText(/confirm your password/i), "x");
    await vi.waitFor(
      () => expect(screen.queryByText(/please confirm your password/i)).not.toBeInTheDocument(),
      { timeout: 1500 }
    );
  });
});
