/**
 * Component tests for <LoginForm> (rescan-4 M14).
 * 391-line orchestration component that owns the credentials login flow.
 * Pins:
 *  - Activation banner from ?message=
 *  - Deactivated banner from ?error=AccessDenied (with URL cleanup)
 *  - Checkout-returnUrl banner
 *  - Submit calls signIn('credentials', {…}) with the right body
 *  - Result paths: TotpRequired reveals TOTP without toast; InvalidTotpCode
 *    toast.error + reset; AccountNotActivated toast.error + router.push;
 *    AccountDeactivated/AccessDenied → showAccountDeactivated; default
 *    failure → 'Invalid email or password'; ok → success toast + 100ms
 *    redirect to safeReturnUrl
 *  - Remember-me persistence: checked → setItem; unchecked → removeItem
 *  - Open-redirect defence: external returnUrl falls back to /dashboard
 *  - Password show/hide toggle
 *
 * Heavy mock setup — useRouter + useSearchParams + signIn + toast
 * helpers + safeLocalStorage + the
 * AuthShell + SocialLoginButtons subcomponents replaced with light shims.
 */
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const signInMock = vi.hoisted(() => vi.fn());
vi.mock("next-auth/react", () => ({ signIn: signInMock }));

const pushMock = vi.hoisted(() => vi.fn());
const useSearchParamsMock = vi.hoisted(() => vi.fn(() => new URLSearchParams()));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
  useSearchParams: useSearchParamsMock,
}));

const successToast = vi.hoisted(() => vi.fn());
const errorToast = vi.hoisted(() => vi.fn());
const deactivatedToast = vi.hoisted(() => vi.fn());
vi.mock("@/lib/toast", () => ({
  showSuccessToast: successToast,
  showErrorToast: errorToast,
  showAccountDeactivated: deactivatedToast,
}));

vi.mock("react-hot-toast", () => ({
  default: { success: vi.fn(), error: vi.fn() },
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

vi.mock("@/lib/logger", () => ({
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/components/AuthShell", () => ({
  default: ({
    children,
    title,
    subtitle,
  }: {
    children: React.ReactNode;
    title: string;
    subtitle?: React.ReactNode;
  }) => (
    <div>
      <h1>{title}</h1>
      {subtitle && <div data-testid="subtitle">{subtitle}</div>}
      {children}
    </div>
  ),
}));

vi.mock("@/components/SocialLoginButtons", () => ({
  default: () => <div data-testid="social-stub" />,
}));

import LoginForm from "@/components/LoginForm";

beforeEach(() => {
  signInMock.mockReset();
  pushMock.mockReset();
  successToast.mockReset();
  errorToast.mockReset();
  deactivatedToast.mockReset();
  useSearchParamsMock.mockReturnValue(new URLSearchParams());
  lsStore.clear();
  vi.stubEnv("NODE_ENV", "test");
  Object.defineProperty(window, "location", {
    value: {
      ...window.location,
      pathname: "/login",
      search: "",
      href: "http://localhost/login",
    },
    writable: true,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("<LoginForm>", () => {
  it("renders the email + password fields, Remember me, Forgot password, and Sign in button", () => {
    render(<LoginForm />);
    expect(screen.getByRole("heading", { name: /sign in to your account/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/enter your email address/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/enter your password/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/remember me/i)).toBeChecked();
    expect(screen.getByRole("link", { name: /forgot your password/i })).toHaveAttribute(
      "href",
      "/reset-password"
    );
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  it("'Create an account' link respects the returnUrl search param", () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams("returnUrl=/checkout"));
    render(<LoginForm />);
    const subtitle = screen.getByTestId("subtitle");
    const link = subtitle.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/register?returnUrl=%2Fcheckout");
  });

  it("?message=Foo renders the green activation banner", () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams("message=Account%20activated"));
    render(<LoginForm />);
    expect(screen.getByText(/account activated/i)).toBeInTheDocument();
  });

  it("?returnUrl=/checkout shows the checkout-required banner", () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams("returnUrl=/checkout"));
    render(<LoginForm />);
    expect(screen.getByText(/please sign in to complete your purchase/i)).toBeInTheDocument();
  });

  it("?error=AccessDenied surfaces the deactivated-account message + cleans the URL", () => {
    useSearchParamsMock.mockReturnValue(new URLSearchParams("error=AccessDenied"));
    const replaceSpy = vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
    render(<LoginForm />);
    expect(screen.getByText(/your account has been deactivated/i)).toBeInTheDocument();
    expect(replaceSpy).toHaveBeenCalled();
    replaceSpy.mockRestore();
  });

  it("password eye toggles type=password ↔ type=text", async () => {
    const user = userEvent.setup();
    render(<LoginForm />);
    const pw = screen.getByPlaceholderText(/enter your password/i) as HTMLInputElement;
    expect(pw.type).toBe("password");
    // The eye button has no accessible name — find it as the input's right-icon button.
    // It's the only `type="button"` in the form besides the Sign in button.
    const buttons = screen.getAllByRole("button");
    const eyeBtn = buttons.find((b) => b.getAttribute("type") === "button" && !/sign in/i.test(b.textContent || ""));
    expect(eyeBtn).toBeTruthy();
    await user.click(eyeBtn!);
    expect(pw.type).toBe("text");
  });

  it("submit → signIn('credentials', {...}) with email/password and the returnUrl callbackUrl", async () => {
    const user = userEvent.setup();
    useSearchParamsMock.mockReturnValue(new URLSearchParams("returnUrl=/dashboard"));
    signInMock.mockResolvedValue({ ok: false, error: "CredentialsSignin" });
    render(<LoginForm />);
    await user.type(screen.getByPlaceholderText(/enter your email address/i), "a@b.com");
    await user.type(screen.getByPlaceholderText(/enter your password/i), "pw123");
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => expect(signInMock).toHaveBeenCalled());
    expect(signInMock).toHaveBeenCalledWith(
      "credentials",
      expect.objectContaining({
        email: "a@b.com",
        password: "pw123",
        redirect: false,
        callbackUrl: "/dashboard",
      })
    );
  });

  it("CredentialsSignin error → 'Invalid email or password' toast", async () => {
    const user = userEvent.setup();
    signInMock.mockResolvedValueOnce({ ok: false, error: "CredentialsSignin" });
    render(<LoginForm />);
    await user.type(screen.getByPlaceholderText(/enter your email address/i), "a@b.com");
    await user.type(screen.getByPlaceholderText(/enter your password/i), "wrong");
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith(expect.stringMatching(/invalid email or password/i))
    );
  });

  it("TotpRequired → reveals the authenticator-code step without any error toast", async () => {
    const user = userEvent.setup();
    signInMock.mockResolvedValueOnce({ ok: false, error: "TotpRequired" });
    render(<LoginForm />);
    await user.type(screen.getByPlaceholderText(/enter your email address/i), "a@b.com");
    await user.type(screen.getByPlaceholderText(/enter your password/i), "pw");
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() =>
      expect(screen.getByText(/two-factor authentication required/i)).toBeInTheDocument()
    );
    expect(errorToast).not.toHaveBeenCalled();
  });

  it("InvalidTotpCode → toast.error 'Invalid authenticator code'", async () => {
    const user = userEvent.setup();
    signInMock.mockResolvedValueOnce({ ok: false, error: "InvalidTotpCode" });
    render(<LoginForm />);
    await user.type(screen.getByPlaceholderText(/enter your email address/i), "a@b.com");
    await user.type(screen.getByPlaceholderText(/enter your password/i), "pw");
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith(expect.stringMatching(/invalid authenticator code/i))
    );
  });

  it("AccountNotActivated → inline 'activate first' notice + Resend button; does NOT redirect to /activate", async () => {
    const user = userEvent.setup();
    signInMock.mockResolvedValueOnce({ ok: false, error: "AccountNotActivated" });
    render(<LoginForm />);
    await user.type(screen.getByPlaceholderText(/enter your email address/i), "a@b.com");
    await user.type(screen.getByPlaceholderText(/enter your password/i), "pw");
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith(expect.stringMatching(/isn.?t activated yet/i))
    );
    // Clear "activate first" notice + a Resend action are shown in-page …
    expect(screen.getByText(/isn.?t activated yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /resend activation email/i })).toBeInTheDocument();
    // … and we do NOT bounce the user to the token-only /activate page.
    expect(pushMock).not.toHaveBeenCalledWith(expect.stringContaining("/activate"));
  });

  it("AccountDeactivated → showAccountDeactivated", async () => {
    const user = userEvent.setup();
    signInMock.mockResolvedValueOnce({ ok: false, error: "AccountDeactivated" });
    render(<LoginForm />);
    await user.type(screen.getByPlaceholderText(/enter your email address/i), "a@b.com");
    await user.type(screen.getByPlaceholderText(/enter your password/i), "pw");
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => expect(deactivatedToast).toHaveBeenCalled());
  });

  it("ok=true → success toast and 100ms-delayed redirect to safeReturnUrl", async () => {
    vi.useFakeTimers();
    try {
      signInMock.mockResolvedValueOnce({ ok: true });
      const hrefSetter = vi.fn();
      Object.defineProperty(window, "location", {
        value: {
          ...window.location,
          pathname: "/login",
          search: "?returnUrl=/dashboard",
          set href(v: string) { hrefSetter(v); },
        },
        writable: true,
      });
      render(<LoginForm />);
      const emailInput = screen.getByPlaceholderText(/enter your email address/i);
      const pwInput = screen.getByPlaceholderText(/enter your password/i);
      await act(async () => {
        (emailInput as HTMLInputElement).value = "a@b.com";
        emailInput.dispatchEvent(new Event("input", { bubbles: true }));
        (pwInput as HTMLInputElement).value = "pw";
        pwInput.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        screen.getByRole("button", { name: /sign in/i }).click();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(successToast).toHaveBeenCalledWith(expect.stringMatching(/login successful/i));
      await act(async () => {
        vi.advanceTimersByTime(100);
      });
      expect(hrefSetter).toHaveBeenCalledWith("/dashboard");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Remember me checked → setItem 'rememberMe' + 'savedEmail'; unchecked → removeItem", async () => {
    const user = userEvent.setup();
    signInMock.mockResolvedValue({ ok: false, error: "CredentialsSignin" });
    render(<LoginForm />);
    await user.type(screen.getByPlaceholderText(/enter your email address/i), "a@b.com");
    await user.type(screen.getByPlaceholderText(/enter your password/i), "pw");
    // Default: rememberMe=true
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => expect(lsStore.get("rememberMe")).toBe("true"));
    expect(lsStore.get("savedEmail")).toBe("a@b.com");
    // Uncheck → removes
    await user.click(screen.getByLabelText(/remember me/i));
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => expect(lsStore.has("rememberMe")).toBe(false));
    expect(lsStore.has("savedEmail")).toBe(false);
  });

  it("open-redirect defence: external returnUrl falls back to /dashboard", async () => {
    const user = userEvent.setup();
    signInMock.mockResolvedValueOnce({ ok: false, error: "CredentialsSignin" });
    Object.defineProperty(window, "location", {
      value: {
        ...window.location,
        pathname: "/login",
        search: "?returnUrl=https://evil.example.com/steal",
      },
      writable: true,
    });
    render(<LoginForm />);
    await user.type(screen.getByPlaceholderText(/enter your email address/i), "a@b.com");
    await user.type(screen.getByPlaceholderText(/enter your password/i), "pw");
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() =>
      expect(signInMock).toHaveBeenCalledWith(
        "credentials",
        expect.objectContaining({ callbackUrl: "/dashboard" })
      )
    );
  });
});
